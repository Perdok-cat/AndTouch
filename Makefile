all: server

check-deps:
	@printf '%s\n%s\n' "#include <event2/event.h>" "int main(int a, char** v){}" \
		| gcc -x c -o /dev/null - -levent && \
		echo Dependencies are available || { \
		echo "Dependencies are unavailable"; \
		echo "Please, install libevent development package"; \
		exit 1; \
		}

server: check-deps server.c uinput.c
	gcc -o server server.c uinput.c -levent -lm

.PHONY: check-deps
