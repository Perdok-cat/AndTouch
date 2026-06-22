#!/usr/bin/env sh
set -eu

RULE_NAME="99-remote-touchpad.rules"
SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SOURCE_FILE="$SOURCE_DIR/$RULE_NAME"
TARGET_FILE="/etc/udev/rules.d/$RULE_NAME"

install -Dm644 "$SOURCE_FILE" "$TARGET_FILE"
udevadm control --reload
udevadm trigger --subsystem-match=input

printf '%s\n' "Installed $TARGET_FILE and reloaded udev rules."
