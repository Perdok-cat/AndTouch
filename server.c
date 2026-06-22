#include <arpa/inet.h>
#include <errno.h>
#include <event2/buffer.h>
#include <event2/bufferevent.h>
#include <event2/event.h>
#include <event2/listener.h>
#include <event2/util.h>
#include <netinet/in.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

void process_touch_frame(uint16_t width, uint16_t height, const int16_t touches[10][2]);

#define TCP_PORT 8081
#define TOUCH_PACKET_SIZE 50
#define TOUCH_SLOT_OFFSET 10

struct client_state {
	struct bufferevent *bev;
	uint8_t has_last_seq;
	uint16_t last_seq;
};

static uint16_t
read_u16_le(const unsigned char *p)
{
	return (uint16_t)p[0] | ((uint16_t)p[1] << 8);
}

static int16_t
read_i16_le(const unsigned char *p)
{
	return (int16_t)read_u16_le(p);
}

static int
seq_is_newer(uint16_t seq, uint16_t last)
{
	return (int16_t)(seq - last) > 0;
}

static void
handle_touch_packet(struct client_state *client, const unsigned char payload[TOUCH_PACKET_SIZE])
{
	int16_t touches[10][2];
	uint16_t seq;
	uint16_t width;
	uint16_t height;

	if (payload[0] != 'R' || payload[1] != 'T' || payload[2] != 1)
		return;

	seq = read_u16_le(payload + 4);
	if (client->has_last_seq && !seq_is_newer(seq, client->last_seq))
		return;

	client->has_last_seq = 1;
	client->last_seq = seq;

	width = read_u16_le(payload + 6);
	height = read_u16_le(payload + 8);
	for (int i = 0; i < 10; i++) {
		int offset = TOUCH_SLOT_OFFSET + i * 4;
		touches[i][0] = read_i16_le(payload + offset);
		touches[i][1] = read_i16_le(payload + offset + 2);
	}

	process_touch_frame(width, height, touches);
}

static void
client_read_cb(struct bufferevent *bev, void *ctx)
{
	struct client_state *client = ctx;
	struct evbuffer *input = bufferevent_get_input(bev);
	unsigned char payload[TOUCH_PACKET_SIZE];

	while (evbuffer_get_length(input) >= TOUCH_PACKET_SIZE) {
		if (evbuffer_remove(input, payload, sizeof(payload)) != TOUCH_PACKET_SIZE)
			return;
		handle_touch_packet(client, payload);
	}
}

static void
client_event_cb(struct bufferevent *bev, short events, void *ctx)
{
	struct client_state *client = ctx;

	if (events & (BEV_EVENT_EOF | BEV_EVENT_ERROR)) {
		if (events & BEV_EVENT_ERROR) {
			int err = EVUTIL_SOCKET_ERROR();
			fprintf(stderr, "Client disconnected with socket error: %s\n",
				evutil_socket_error_to_string(err));
		} else {
			fprintf(stderr, "Client disconnected\n");
		}

		bufferevent_free(bev);
		free(client);
	}
}

static void
accept_conn_cb(struct evconnlistener *listener, evutil_socket_t fd,
	struct sockaddr *address, int socklen, void *ctx)
{
	struct event_base *base = ctx;
	struct bufferevent *bev;
	struct client_state *client;
	(void)listener;
	(void)address;
	(void)socklen;

	bev = bufferevent_socket_new(base, fd, BEV_OPT_CLOSE_ON_FREE);
	if (!bev) {
		fprintf(stderr, "Failed to create bufferevent for incoming client\n");
		evutil_closesocket(fd);
		return;
	}

	client = calloc(1, sizeof(*client));
	if (!client) {
		fprintf(stderr, "Failed to allocate client state\n");
		bufferevent_free(bev);
		return;
	}

	client->bev = bev;
	bufferevent_setcb(bev, client_read_cb, NULL, client_event_cb, client);
	bufferevent_enable(bev, EV_READ | EV_WRITE);
	printf("ADB/TCP client connected\n");
}

static void
accept_error_cb(struct evconnlistener *listener, void *ctx)
{
	struct event_base *base = ctx;
	int err = EVUTIL_SOCKET_ERROR();

	(void)listener;
	fprintf(stderr, "Listener error %d: %s\n", err, evutil_socket_error_to_string(err));
	event_base_loopexit(base, NULL);
}

static void
do_term(evutil_socket_t sig, short events, void *arg)
{
	struct event_base *base = arg;

	(void)events;
	event_base_loopbreak(base);
	fprintf(stderr, "Got %d, terminating\n", (int)sig);
}

int
main(void)
{
	struct event_base *base = NULL;
	struct evconnlistener *listener = NULL;
	struct event *term = NULL;
	struct sockaddr_in addr = {0};
	int ret = 0;

	if (signal(SIGPIPE, SIG_IGN) == SIG_ERR) {
		ret = 1;
		goto err;
	}

	setbuf(stdout, NULL);
	setbuf(stderr, NULL);

	base = event_base_new();
	if (!base) {
		fprintf(stderr, "Couldn't create an event base\n");
		ret = 1;
		goto err;
	}

	addr.sin_family = AF_INET;
	addr.sin_addr.s_addr = htonl(INADDR_ANY);
	addr.sin_port = htons(TCP_PORT);

	listener = evconnlistener_new_bind(
		base,
		accept_conn_cb,
		base,
		LEV_OPT_CLOSE_ON_FREE | LEV_OPT_REUSEABLE,
		-1,
		(const struct sockaddr *)&addr,
		sizeof(addr));
	if (!listener) {
		fprintf(stderr, "Couldn't bind TCP listener to port %d\n", TCP_PORT);
		ret = 1;
		goto err;
	}

	evconnlistener_set_error_cb(listener, accept_error_cb);

	term = evsignal_new(base, SIGINT, do_term, base);
	if (!term || event_add(term, NULL)) {
		fprintf(stderr, "Couldn't install SIGINT handler\n");
		ret = 1;
		goto err;
	}

	printf("ADB/TCP input started on port %d\n", TCP_PORT);
	event_base_dispatch(base);

err:
	if (listener)
		evconnlistener_free(listener);
	if (term)
		event_free(term);
	if (base)
		event_base_free(base);

	return ret;
}
