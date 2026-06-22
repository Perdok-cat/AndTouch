# Remote Touchpad

`remote_touchpad` turns an Android tablet or phone into an external multitouch touchpad for Linux through `uinput`.

The project uses:

- `USB + ADB reverse + TCP` from the Android app on port `8081`
- a virtual Linux multitouch touchpad device that `libinput` can recognize

## Server

Build and run the Linux server:

```sh
make
sudo ./server
```

The server listens for ADB-forwarded TCP input on `8081`.

### Make Linux recognize it as a touchpad

Install the included udev rule once as root:

```sh
sudo ./scripts/install-udev-rule.sh
```

This tags the virtual device as:

- `ID_INPUT=1`
- `ID_INPUT_TOUCHPAD=1`
- `ID_INPUT_TOUCHPAD_INTEGRATION=external`

After that, restart the server if it is already running.

## Android client

A React Native Android app lives in [mobile](/home/binperdok/OpenSource/remote_touchpad/mobile).

### Build

```sh
cd mobile
npm install
cd android
./gradlew assembleDebug
```

Debug APK output:

```text
mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

### Use

1. Start the Linux server with `sudo ./server`.
2. Install the debug APK on an Android device.
3. Connect the Android device to Linux over USB.
4. Enable USB debugging on the Android device.
5. Run `adb reverse tcp:8081 tcp:8081` on Linux.
6. Open the app and keep port `8081` unless you change the server.
7. Open the `Settings` tab to adjust the ADB port and `Cursor speed`.
8. Tap `Connect`, switch back to `Touchpad`, then use the full-screen touch surface.
9. Open your Linux desktop touchpad settings and enable options like tap-to-click, natural scrolling, and three-finger gestures if desired.
10. Test with `libinput list-devices` or your desktop settings panel and verify the device appears as `remote-touchpad-touchpad`.

The app connects to `127.0.0.1` on the phone. `adb reverse` carries that TCP stream over USB to the Linux server.

## Notes

- This version aims to behave like a real touchpad, so click/tap/gesture behavior is primarily handled by Linux `libinput` and your desktop environment.
- Three-finger actions now depend on your compositor or desktop gesture settings instead of custom hardcoded mouse emulation in this project.
- Because the virtual device is created through `/dev/uinput`, the server still needs `sudo`.

## TCP frame format

Each TCP frame is exactly `50` bytes, little-endian:

```text
0-1   magic: "RT"
2     version: 1
3     active touch count
4-5   sequence number
6-7   surface width
8-9   surface height
10-49 10 touch slots, each slot:
      x:int16, y:int16
```

Unused touch coordinates are sent as `-1`.
