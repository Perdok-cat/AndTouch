#include <fcntl.h>
#include <linux/input.h>
#include <linux/uinput.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>
#include <unistd.h>

#define MAX_TOUCHES 10
#define DEFAULT_WIDTH_MM 160
#define DEFAULT_HEIGHT_MM 100

#define die(str, args...) do { \
		dprintf(2, "On line %d:\n\t", __LINE__); \
		perror(str); \
		exit(EXIT_FAILURE); \
	} while(0)

struct touch_state {
	int tracking_id;
	int16_t x;
	int16_t y;
	uint8_t active;
};

struct touchpad_state {
	int fd;
	uint16_t width;
	uint16_t height;
	uint8_t current_mt_slot;
	uint16_t next_tracking_id;
	struct touch_state slots[MAX_TOUCHES];
} touchpad_device = {.fd = -1, .current_mt_slot = 0xff};

static inline void
write_event(struct touchpad_state *state, int type, int code, int value)
{
	struct input_event event = {0};
	gettimeofday(&event.time, NULL);
	event.type = type;
	event.code = code;
	event.value = value;
	write(state->fd, &event, sizeof(event));
}

static inline void
sync_events(struct touchpad_state *state)
{
	write_event(state, EV_SYN, SYN_REPORT, 0);
}

static inline void
reset_slots(struct touchpad_state *state)
{
	for (int i = 0; i < MAX_TOUCHES; i++) {
		state->slots[i].tracking_id = -1;
		state->slots[i].x = -1;
		state->slots[i].y = -1;
		state->slots[i].active = 0;
	}

	state->current_mt_slot = 0xff;
	state->next_tracking_id = 1;
}

static inline void
release_uinput(struct touchpad_state *state)
{
	if (state->fd == -1)
		return;

	if (ioctl(state->fd, UI_DEV_DESTROY) < 0)
		die("error: ioctl");
	close(state->fd);
	state->fd = -1;
}

static inline void
setup_abs_axis(int fd, unsigned int code, int minimum, int maximum, int resolution)
{
	struct uinput_abs_setup setup = {
		.code = code,
		.absinfo =
			{
				.minimum = minimum,
				.maximum = maximum,
				.resolution = resolution,
			},
	};

	if (ioctl(fd, UI_ABS_SETUP, &setup) < 0)
		die("error: ioctl");
}

static inline void
reset_uinput_device(struct touchpad_state *state)
{
	struct uinput_user_dev user_dev = {0};
	int width_resolution;
	int height_resolution;

	release_uinput(state);
	reset_slots(state);

	state->fd = open("/dev/uinput", O_WRONLY | O_NONBLOCK);
	if (state->fd < 0)
		die("error: open");

	snprintf(user_dev.name, UINPUT_MAX_NAME_SIZE, "remote-touchpad-touchpad");
	user_dev.id.bustype = BUS_BLUETOOTH;
	user_dev.id.vendor = 0xdecb;
	user_dev.id.product = 0xacde;
	user_dev.id.version = 2;

#define SET(type, code) if (ioctl(state->fd, UI_SET_##type##BIT, code) < 0) \
		die("error: ioctl");
	SET(EV, EV_SYN);
	SET(EV, EV_KEY);
	SET(EV, EV_ABS);
	SET(PROP, INPUT_PROP_POINTER);
	SET(KEY, BTN_TOUCH);
	SET(KEY, BTN_LEFT);
	SET(KEY, BTN_TOOL_FINGER);
	SET(KEY, BTN_TOOL_DOUBLETAP);
	SET(KEY, BTN_TOOL_TRIPLETAP);
	SET(KEY, BTN_TOOL_QUADTAP);
	SET(KEY, BTN_TOOL_QUINTTAP);
	SET(ABS, ABS_X);
	SET(ABS, ABS_Y);
	SET(ABS, ABS_PRESSURE);
	SET(ABS, ABS_MT_SLOT);
	SET(ABS, ABS_MT_TRACKING_ID);
	SET(ABS, ABS_MT_POSITION_X);
	SET(ABS, ABS_MT_POSITION_Y);
	SET(ABS, ABS_MT_PRESSURE);
	SET(ABS, ABS_MT_TOUCH_MAJOR);
	SET(ABS, ABS_MT_TOUCH_MINOR);
	SET(ABS, ABS_MT_ORIENTATION);
#undef SET

	if (write(state->fd, &user_dev, sizeof(user_dev)) < 0)
		die("error: write");

	width_resolution = state->width > 0 ? (int)(state->width / DEFAULT_WIDTH_MM) : 1;
	height_resolution = state->height > 0 ? (int)(state->height / DEFAULT_HEIGHT_MM) : 1;
	if (width_resolution < 1)
		width_resolution = 1;
	if (height_resolution < 1)
		height_resolution = 1;

	setup_abs_axis(state->fd, ABS_X, 0, state->width, width_resolution);
	setup_abs_axis(state->fd, ABS_Y, 0, state->height, height_resolution);
	setup_abs_axis(state->fd, ABS_PRESSURE, 0, 255, 0);
	setup_abs_axis(state->fd, ABS_MT_SLOT, 0, MAX_TOUCHES - 1, 0);
	setup_abs_axis(state->fd, ABS_MT_TRACKING_ID, -1, 65535, 0);
	setup_abs_axis(state->fd, ABS_MT_POSITION_X, 0, state->width, width_resolution);
	setup_abs_axis(state->fd, ABS_MT_POSITION_Y, 0, state->height, height_resolution);
	setup_abs_axis(state->fd, ABS_MT_PRESSURE, 0, 255, 0);
	setup_abs_axis(state->fd, ABS_MT_TOUCH_MAJOR, 0, 255, 0);
	setup_abs_axis(state->fd, ABS_MT_TOUCH_MINOR, 0, 255, 0);
	setup_abs_axis(state->fd, ABS_MT_ORIENTATION, -1, 1, 0);

	if (ioctl(state->fd, UI_DEV_CREATE) < 0)
		die("error: ioctl");

	/* Give udev/libinput a moment to discover the fresh virtual device. */
	usleep(20 * 1000);
}

static inline void
select_mt_slot(struct touchpad_state *state, uint8_t slot)
{
	if (state->current_mt_slot == slot)
		return;

	state->current_mt_slot = slot;
	write_event(state, EV_ABS, ABS_MT_SLOT, slot);
}

static inline int
tool_code_for_touch_count(uint8_t count)
{
	switch (count) {
	case 1:
		return BTN_TOOL_FINGER;
	case 2:
		return BTN_TOOL_DOUBLETAP;
	case 3:
		return BTN_TOOL_TRIPLETAP;
	case 4:
		return BTN_TOOL_QUADTAP;
	default:
		return BTN_TOOL_QUINTTAP;
	}
}

static inline uint8_t
count_active_touches(const int16_t touches[MAX_TOUCHES][2])
{
	uint8_t count = 0;

	for (int i = 0; i < MAX_TOUCHES; i++) {
		if (touches[i][0] >= 0 && touches[i][1] >= 0)
			count++;
	}

	return count;
}

void
process_touch_frame(uint16_t width, uint16_t height, const int16_t touches[MAX_TOUCHES][2])
{
	struct touchpad_state *state = &touchpad_device;
	uint8_t touch_count;

	if (width == 0 || height == 0)
		return;

	if (state->fd == -1 || width != state->width || height != state->height) {
		state->width = width;
		state->height = height;
		reset_uinput_device(state);
	}

	touch_count = count_active_touches(touches);

	for (uint8_t i = 0; i < MAX_TOUCHES; i++) {
		struct touch_state *slot = &state->slots[i];
		int16_t next_x = touches[i][0];
		int16_t next_y = touches[i][1];
		uint8_t next_active = next_x >= 0 && next_y >= 0;

		if (!next_active && !slot->active)
			continue;

		select_mt_slot(state, i);

		if (next_active && !slot->active) {
			slot->tracking_id = state->next_tracking_id++;
			slot->active = 1;
			write_event(state, EV_ABS, ABS_MT_TRACKING_ID, slot->tracking_id);
			write_event(state, EV_ABS, ABS_MT_TOUCH_MAJOR, 25);
			write_event(state, EV_ABS, ABS_MT_TOUCH_MINOR, 20);
			write_event(state, EV_ABS, ABS_MT_PRESSURE, 40);
			write_event(state, EV_ABS, ABS_MT_ORIENTATION, 0);
		} else if (!next_active && slot->active) {
			write_event(state, EV_ABS, ABS_MT_TRACKING_ID, -1);
			slot->tracking_id = -1;
			slot->active = 0;
			slot->x = -1;
			slot->y = -1;
			continue;
		}

		if (slot->x != next_x) {
			write_event(state, EV_ABS, ABS_MT_POSITION_X, next_x);
			slot->x = next_x;
		}

		if (slot->y != next_y) {
			write_event(state, EV_ABS, ABS_MT_POSITION_Y, next_y);
			slot->y = next_y;
		}
	}

	for (int i = 1; i <= 5; i++)
		write_event(state, EV_KEY, tool_code_for_touch_count(i), touch_count == i);

	write_event(state, EV_KEY, BTN_TOUCH, touch_count > 0);

	if (touch_count > 0) {
		for (int i = 0; i < MAX_TOUCHES; i++) {
			if (!state->slots[i].active)
				continue;
			write_event(state, EV_ABS, ABS_X, state->slots[i].x);
			write_event(state, EV_ABS, ABS_Y, state->slots[i].y);
			write_event(state, EV_ABS, ABS_PRESSURE, 40);
			break;
		}
	} else {
		write_event(state, EV_ABS, ABS_PRESSURE, 0);
	}

	sync_events(state);
}

void
process_input(char *payload)
{
	uint8_t i = 0;
	int width = 0;
	int height = 0;
	int16_t touches[MAX_TOUCHES][2];
	char *token;

	for (int k = 0; k < MAX_TOUCHES; k++) {
		touches[k][0] = -1;
		touches[k][1] = -1;
	}

	token = strtok(payload, ",");
	for (i = 0; i < 22; i++) {
		if (!token)
			return;

		int value = atoi(token);
		token = strtok(NULL, ",");
		if (i == 0)
			width = value;
		else if (i == 1)
			height = value;
		else {
			uint8_t k = i - 2;
			uint8_t current = (k - k % 2) / 2;
			if (k % 2 == 0)
				touches[current][0] = value;
			else
				touches[current][1] = value;
		}
	}

	process_touch_frame(width, height, touches);
}
