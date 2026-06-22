import React, {useEffect, useRef, useState} from 'react';
import {
  DeviceEventEmitter,
  Modal,
  NativeModules,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  SafeAreaProvider,
  SafeAreaView,
} from 'react-native-safe-area-context';

const MAX_TOUCHES = 10;
const DEFAULT_PORT = 8081;
const MIN_CURSOR_SCALE = 0.5;
const MAX_CURSOR_SCALE = 2;
const CURSOR_SCALE_STEP = 0.25;
const IMMEDIATE_FRAME_INTERVAL_MS = 8;

type NativeAdbTouch = {
  connect(port: number): Promise<void>;
  disconnect(): void;
  sendFrame(
    width: number,
    height: number,
    touchCount: number,
    touches: number[],
  ): void;
};

const adbTouch = NativeModules.AdbTouch as NativeAdbTouch;

function App() {
  return (
    <SafeAreaProvider>
      <StatusBar hidden />
      <TouchpadScreen />
    </SafeAreaProvider>
  );
}

function TouchpadScreen() {
  const [port, setPort] = useState(String(DEFAULT_PORT));
  const [connected, setConnected] = useState(false);
  const [cursorScale, setCursorScale] = useState(1);
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [status, setStatus] = useState('Disconnected');
  const [surfaceSize, setSurfaceSize] = useState({width: 0, height: 0});

  const connectedRef = useRef(false);
  const cursorScaleRef = useRef(cursorScale);
  const surfaceSizeRef = useRef(surfaceSize);
  const touchSlotsRef = useRef<number[]>(Array(MAX_TOUCHES * 2).fill(-1));
  const touchCountRef = useRef(0);
  const rawTouchByIdRef = useRef<Map<number, {x: number; y: number}>>(new Map());
  const projectedTouchByIdRef = useRef<Map<number, {x: number; y: number}>>(new Map());
  const touchSlotByIdRef = useRef<Map<number, number>>(new Map());
  const framePendingRef = useRef(false);
  const flushScheduledRef = useRef(false);
  const animationFrameRef = useRef<number | null>(null);
  const lastFrameSentAtRef = useRef(0);

  useEffect(() => {
    connectedRef.current = connected;
  }, [connected]);

  useEffect(() => {
    surfaceSizeRef.current = surfaceSize;
  }, [surfaceSize]);

  useEffect(() => {
    cursorScaleRef.current = cursorScale;
  }, [cursorScale]);

  useEffect(() => {
    const subscription = DeviceEventEmitter.addListener('AdbTouchStatus', event => {
      const type = typeof event?.type === 'string' ? event.type : '';
      const message =
        typeof event?.message === 'string' ? event.message : 'ADB/TCP error';

      if (type === 'connected') {
        setStatus(message);
        return;
      }

      if (type === 'disconnected') {
        connectedRef.current = false;
        setConnected(false);
        clearFrameLoop();
        setStatus(message);
        return;
      }

      if (type === 'error') {
        connectedRef.current = false;
        setConnected(false);
        clearFrameLoop();
        clearTouches();
        setStatus(message);
      }
    });

    return () => {
      subscription.remove();
      clearFrameLoop();
      adbTouch.disconnect();
    };
  }, []);

  function clearFrameLoop() {
    framePendingRef.current = false;
    flushScheduledRef.current = false;
    lastFrameSentAtRef.current = 0;
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
  }

  function now() {
    const perf = (globalThis as {performance?: {now?: () => number}}).performance;
    if (typeof perf?.now === 'function') {
      return perf.now();
    }

    return Date.now();
  }

  function clampCursorScale(value: number) {
    const rounded = Math.round(value / CURSOR_SCALE_STEP) * CURSOR_SCALE_STEP;
    return Math.min(MAX_CURSOR_SCALE, Math.max(MIN_CURSOR_SCALE, rounded));
  }

  function clampCoordinate(value: number, max: number) {
    if (max <= 0) {
      return 0;
    }

    return Math.max(0, Math.min(max, value));
  }

  function sendCurrentFrame() {
    framePendingRef.current = false;
    flushScheduledRef.current = false;
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    if (!connectedRef.current) {
      return;
    }

    const {width, height} = surfaceSizeRef.current;
    if (!width || !height) {
      return;
    }

    lastFrameSentAtRef.current = now();
    adbTouch.sendFrame(
      width,
      height,
      touchCountRef.current,
      touchSlotsRef.current,
    );
  }

  function scheduleSend() {
    if (!connectedRef.current) {
      return;
    }

    framePendingRef.current = true;
    if (flushScheduledRef.current) {
      return;
    }

    flushScheduledRef.current = true;
    animationFrameRef.current = requestAnimationFrame(() => {
      animationFrameRef.current = null;
      flushScheduledRef.current = false;
      const {width, height} = surfaceSizeRef.current;

      if (!connectedRef.current || !framePendingRef.current || !width || !height) {
        return;
      }

      framePendingRef.current = false;
      sendCurrentFrame();
    });
  }

  function clearTouches() {
    touchSlotsRef.current = Array(MAX_TOUCHES * 2).fill(-1);
    touchCountRef.current = 0;
    rawTouchByIdRef.current = new Map();
    projectedTouchByIdRef.current = new Map();
    touchSlotByIdRef.current = new Map();
  }

  function updateTouches(
    touches: readonly {
      identifier: string | number;
      locationX: number;
      locationY: number;
    }[],
  ) {
    const next = Array(MAX_TOUCHES * 2).fill(-1);
    const {width, height} = surfaceSizeRef.current;
    const activeTouches = touches
      .filter(touch =>
        Number.isFinite(Number(touch.identifier)) &&
        Number.isFinite(touch.locationX) &&
        Number.isFinite(touch.locationY),
      )
      .slice(0, MAX_TOUCHES);
    const previousRawMap = rawTouchByIdRef.current;
    const previousSlots = touchSlotsRef.current;
    const previousProjectedMap = projectedTouchByIdRef.current;
    const previousMap = touchSlotByIdRef.current;
    const nextMap = new Map<number, number>();
    const nextRawMap = new Map<number, {x: number; y: number}>();
    const nextProjectedMap = new Map<number, {x: number; y: number}>();
    const usedSlots = new Set<number>();

    for (const touch of activeTouches) {
      const identifier = Number(touch.identifier);
      const existingSlot = previousMap.get(identifier);

      if (existingSlot !== undefined && existingSlot >= 0 && existingSlot < MAX_TOUCHES) {
        nextMap.set(identifier, existingSlot);
        usedSlots.add(existingSlot);
      }
    }

    for (const touch of activeTouches) {
      const identifier = Number(touch.identifier);
      if (nextMap.has(identifier)) {
        continue;
      }

      for (let slot = 0; slot < MAX_TOUCHES; slot += 1) {
        if (usedSlots.has(slot)) {
          continue;
        }

        nextMap.set(identifier, slot);
        usedSlots.add(slot);
        break;
      }
    }

    for (const touch of activeTouches) {
      const identifier = Number(touch.identifier);
      const slot = nextMap.get(identifier);
      if (slot === undefined) {
        continue;
      }

      const rawX = clampCoordinate(touch.locationX, width);
      const rawY = clampCoordinate(touch.locationY, height);
      const previousRaw = previousRawMap.get(identifier);
      const previousProjected = previousProjectedMap.get(identifier);
      const previousX = previousSlots[slot * 2];
      const previousY = previousSlots[slot * 2 + 1];

      let nextX = rawX;
      let nextY = rawY;
      if (
        previousRaw &&
        previousProjected &&
        previousX >= 0 &&
        previousY >= 0
      ) {
        nextX = clampCoordinate(
          previousProjected.x + (rawX - previousRaw.x) * cursorScaleRef.current,
          width,
        );
        nextY = clampCoordinate(
          previousProjected.y + (rawY - previousRaw.y) * cursorScaleRef.current,
          height,
        );
      }

      next[slot * 2] = Math.round(nextX);
      next[slot * 2 + 1] = Math.round(nextY);
      nextRawMap.set(identifier, {x: rawX, y: rawY});
      nextProjectedMap.set(identifier, {x: nextX, y: nextY});
    }

    touchSlotsRef.current = next;
    touchCountRef.current = activeTouches.length;
    rawTouchByIdRef.current = nextRawMap;
    projectedTouchByIdRef.current = nextProjectedMap;
    touchSlotByIdRef.current = nextMap;
  }

  function commitTouches(options: {
    forceImmediate?: boolean;
    clear?: boolean;
    touches?: readonly {
      identifier: string | number;
      locationX: number;
      locationY: number;
    }[];
  }) {
    const previousCount = touchCountRef.current;

    if (options.clear) {
      clearTouches();
    } else if (options.touches) {
      updateTouches(options.touches);
    }

    const nextCount = touchCountRef.current;
    const shouldSendImmediately =
      options.forceImmediate ||
      previousCount !== nextCount ||
      previousCount === 0 ||
      nextCount === 0 ||
      now() - lastFrameSentAtRef.current >= IMMEDIATE_FRAME_INTERVAL_MS;

    if (shouldSendImmediately) {
      sendCurrentFrame();
      return;
    }

    scheduleSend();
  }

  async function handleConnectPress() {
    if (connected) {
      connectedRef.current = false;
      setConnected(false);
      clearFrameLoop();
      clearTouches();
      adbTouch.disconnect();
      setStatus('Disconnected');
      return;
    }

    const nextPort = Number(port) || DEFAULT_PORT;
    setStatus(`Connecting to 127.0.0.1:${nextPort} through adb reverse...`);

    try {
      await adbTouch.connect(nextPort);
      connectedRef.current = true;
      setConnected(true);
      setStatus(`Connected via ADB on 127.0.0.1:${nextPort}`);
    } catch (error: unknown) {
      connectedRef.current = false;
      setConnected(false);
      setStatus(error instanceof Error ? error.message : 'ADB/TCP connect failed');
    }
  }

  function handleSettingsVisibility(nextVisible: boolean) {
    if (nextVisible === settingsVisible) {
      return;
    }

    if (settingsVisible && touchCountRef.current > 0) {
      commitTouches({forceImmediate: true, clear: true});
    }

    setSettingsVisible(nextVisible);
  }

  const resolvedPort = Number(port) || DEFAULT_PORT;
  const canDecreaseSpeed = cursorScale > MIN_CURSOR_SCALE;
  const canIncreaseSpeed = cursorScale < MAX_CURSOR_SCALE;

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'right', 'bottom', 'left']}>
      <View style={styles.container}>
        <View
          onLayout={event => {
            const {width, height} = event.nativeEvent.layout;
            setSurfaceSize({width: Math.round(width), height: Math.round(height)});
          }}
          onMoveShouldSetResponder={() => connected}
          onResponderGrant={event => {
            commitTouches({
              forceImmediate: true,
              touches: event.nativeEvent.touches,
            });
          }}
          onResponderMove={event => {
            commitTouches({touches: event.nativeEvent.touches});
          }}
          onResponderRelease={event => {
            commitTouches({
              forceImmediate: true,
              touches: event.nativeEvent.touches,
            });
          }}
          onResponderTerminate={() => {
            commitTouches({forceImmediate: true, clear: true});
          }}
          onStartShouldSetResponder={() => connected}
          style={styles.touchSurface}>
          <View style={styles.overlayTopRow}>
            <View style={styles.overlayStatusPill}>
              <View
                style={[
                  styles.dot,
                  styles.overlayStatusDot,
                  connected ? styles.dotLive : styles.dotIdle,
                ]}
              />
              <Text style={styles.overlayStatusText}>
                {connected ? 'Live' : 'Idle'}
              </Text>
            </View>
            <View style={styles.overlayActions}>
              <Pressable
                onPress={() => handleSettingsVisibility(true)}
                style={styles.overlayGhostButton}>
                <Text style={styles.overlayGhostButtonText}>Settings</Text>
              </Pressable>
              <Pressable
                onPress={handleConnectPress}
                style={[
                  styles.button,
                  styles.overlayConnectButton,
                  connected ? styles.disconnectButton : styles.connectButton,
                ]}>
                <Text style={styles.buttonText}>{connected ? 'Stop' : 'Connect'}</Text>
              </Pressable>
            </View>
          </View>

          <View style={styles.overlayBottomLeft}>
            <Text style={styles.overlayTitle}>Remote Touchpad</Text>
            <Text style={styles.overlayMeta}>
              {surfaceSize.width}x{surfaceSize.height} | {cursorScale.toFixed(2)}x | port {resolvedPort}
            </Text>
            <Text style={styles.overlayHint}>
              {connected
                ? status
                : 'Open Settings for port and speed, then tap Connect.'}
            </Text>
          </View>
        </View>

        <Modal
          animationType="slide"
          onRequestClose={() => handleSettingsVisibility(false)}
          presentationStyle="overFullScreen"
          transparent
          visible={settingsVisible}>
          <View style={styles.modalBackdrop}>
            <Pressable
              onPress={() => handleSettingsVisibility(false)}
              style={styles.modalScrim}
            />
            <View style={styles.settingsSheet}>
              <View style={styles.sheetHandle} />
              <View style={styles.sheetHeader}>
                <View style={styles.sheetHeaderCopy}>
                  <Text style={styles.sheetTitle}>Settings</Text>
                  <Text style={styles.sheetSubtitle}>
                    Tune the connection and pointer without shrinking the touchpad.
                  </Text>
                </View>
                <Pressable
                  onPress={() => handleSettingsVisibility(false)}
                  style={styles.sheetCloseButton}>
                  <Text style={styles.sheetCloseButtonText}>Close</Text>
                </Pressable>
              </View>

              <ScrollView
                contentContainerStyle={styles.settingsContent}
                showsVerticalScrollIndicator={false}>
                <View style={styles.settingsCard}>
                  <Text style={styles.cardTitle}>Connection</Text>
                  <Text style={styles.commandLabel}>ADB/TCP port</Text>
                  <TextInput
                    editable={!connected}
                    keyboardType="number-pad"
                    onChangeText={setPort}
                    placeholder={String(DEFAULT_PORT)}
                    placeholderTextColor="#6f7478"
                    style={styles.portInput}
                    value={port}
                  />
                  <Text style={styles.settingsHint}>
                    Keep the same port on Linux and Android. Port changes are locked while connected.
                  </Text>
                </View>

                <View style={styles.settingsCard}>
                  <Text style={styles.cardTitle}>Pointer</Text>
                  <Text style={styles.commandLabel}>Cursor speed</Text>
                  <View style={styles.speedRow}>
                    <Pressable
                      disabled={!canDecreaseSpeed}
                      onPress={() =>
                        setCursorScale(current =>
                          clampCursorScale(current - CURSOR_SCALE_STEP),
                        )
                      }
                      style={[
                        styles.speedButton,
                        !canDecreaseSpeed && styles.speedButtonDisabled,
                      ]}>
                      <Text style={styles.speedButtonText}>-</Text>
                    </Pressable>
                    <Text style={styles.speedValue}>{cursorScale.toFixed(2)}x</Text>
                    <Pressable
                      disabled={!canIncreaseSpeed}
                      onPress={() =>
                        setCursorScale(current =>
                          clampCursorScale(current + CURSOR_SCALE_STEP),
                        )
                      }
                      style={[
                        styles.speedButton,
                        !canIncreaseSpeed && styles.speedButtonDisabled,
                      ]}>
                      <Text style={styles.speedButtonText}>+</Text>
                    </Pressable>
                  </View>
                  <Text style={styles.settingsHint}>
                    Small, slow motions now keep sub-pixel precision instead of being rounded away frame by frame.
                  </Text>
                </View>

                <View style={styles.settingsCard}>
                  <Text style={styles.cardTitle}>Linux command</Text>
                  <Text style={styles.commandLabel}>Run before Connect</Text>
                  <Text style={styles.commandText}>
                    adb reverse tcp:{resolvedPort} tcp:{resolvedPort}
                  </Text>
                  <Text style={styles.settingsHint}>
                    After connecting, configure tap-to-click or gesture behavior from your Linux touchpad settings.
                  </Text>
                </View>
              </ScrollView>
            </View>
          </View>
        </Modal>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#101317',
  },
  container: {
    flex: 1,
    backgroundColor: '#101317',
    paddingHorizontal: 8,
    paddingBottom: 8,
  },
  portInput: {
    width: '100%',
    borderRadius: 8,
    backgroundColor: '#e7ecef',
    color: '#14181b',
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  button: {
    minWidth: 108,
    borderRadius: 8,
    paddingHorizontal: 18,
    paddingVertical: 12,
    alignItems: 'center',
  },
  connectButton: {
    backgroundColor: '#1f8f57',
  },
  disconnectButton: {
    backgroundColor: '#a64533',
  },
  buttonText: {
    color: '#f7fafb',
    fontSize: 16,
    fontWeight: '700',
  },
  overlayTopRow: {
    position: 'absolute',
    top: 10,
    left: 10,
    right: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  overlayStatusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 999,
    backgroundColor: '#11171bcc',
    borderWidth: 1,
    borderColor: '#2f3940',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  overlayStatusDot: {
    marginRight: 8,
  },
  overlayStatusText: {
    color: '#e7ecef',
    fontSize: 13,
    fontWeight: '600',
  },
  overlayActions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  overlayGhostButton: {
    borderRadius: 999,
    backgroundColor: '#11171bcc',
    borderWidth: 1,
    borderColor: '#2f3940',
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginRight: 8,
  },
  overlayGhostButtonText: {
    color: '#f7fafb',
    fontSize: 13,
    fontWeight: '600',
  },
  overlayConnectButton: {
    minWidth: 92,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  commandLabel: {
    color: '#b8c0c7',
    fontSize: 13,
    marginBottom: 6,
  },
  commandText: {
    color: '#f7fafb',
    fontSize: 16,
    fontWeight: '600',
  },
  settingsContent: {
    paddingBottom: 28,
  },
  settingsCard: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2c343a',
    backgroundColor: '#11171b',
    paddingHorizontal: 14,
    paddingVertical: 14,
    marginBottom: 12,
  },
  cardTitle: {
    color: '#f7fafb',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 12,
  },
  speedRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  speedButton: {
    width: 42,
    height: 42,
    borderRadius: 8,
    backgroundColor: '#1d262c',
    borderWidth: 1,
    borderColor: '#344049',
    alignItems: 'center',
    justifyContent: 'center',
  },
  speedButtonDisabled: {
    opacity: 0.4,
  },
  speedButtonText: {
    color: '#f7fafb',
    fontSize: 24,
    fontWeight: '700',
    lineHeight: 24,
  },
  speedValue: {
    minWidth: 72,
    color: '#f7fafb',
    fontSize: 22,
    fontWeight: '700',
    textAlign: 'center',
    marginHorizontal: 14,
  },
  settingsHint: {
    color: '#b8c0c7',
    fontSize: 13,
    marginTop: 10,
    lineHeight: 18,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 999,
  },
  dotIdle: {
    backgroundColor: '#586068',
  },
  dotLive: {
    backgroundColor: '#32d583',
  },
  statusText: {
    flex: 1,
    color: '#f5f7f8',
    fontSize: 14,
  },
  touchSurface: {
    flex: 1,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#2f3940',
    backgroundColor: '#171d22',
    paddingHorizontal: 18,
    paddingVertical: 18,
  },
  overlayBottomLeft: {
    position: 'absolute',
    left: 18,
    right: 18,
    bottom: 18,
    borderRadius: 16,
    backgroundColor: '#11171bcc',
    borderWidth: 1,
    borderColor: '#2f3940',
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  overlayTitle: {
    color: '#f7fafb',
    fontSize: 22,
    fontWeight: '700',
  },
  overlayMeta: {
    color: '#d1d9de',
    fontSize: 13,
    marginTop: 6,
  },
  overlayHint: {
    color: '#b8c0c7',
    fontSize: 13,
    lineHeight: 18,
    marginTop: 8,
  },
  modalBackdrop: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  modalScrim: {
    flex: 1,
    backgroundColor: '#00000066',
  },
  settingsSheet: {
    maxHeight: '76%',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    backgroundColor: '#101317',
    paddingHorizontal: 16,
    paddingTop: 10,
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 44,
    height: 5,
    borderRadius: 999,
    backgroundColor: '#3a434a',
    marginBottom: 12,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 12,
  },
  sheetHeaderCopy: {
    flex: 1,
    marginRight: 12,
  },
  sheetTitle: {
    color: '#f7fafb',
    fontSize: 22,
    fontWeight: '700',
  },
  sheetSubtitle: {
    color: '#aeb7bd',
    fontSize: 13,
    lineHeight: 18,
    marginTop: 4,
  },
  sheetCloseButton: {
    borderRadius: 999,
    backgroundColor: '#1d262c',
    borderWidth: 1,
    borderColor: '#344049',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  sheetCloseButtonText: {
    color: '#f7fafb',
    fontSize: 13,
    fontWeight: '600',
  },
});

export default App;
