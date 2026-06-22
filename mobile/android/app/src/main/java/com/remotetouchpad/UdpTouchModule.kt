package com.remotetouchpad

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableType
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.IOException
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.Executors
import kotlin.math.roundToInt

class AdbTouchModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  private val executor = Executors.newSingleThreadExecutor()
  private val sendLock = Any()
  private val packet = ByteArray(50)
  private val pendingTouches = IntArray(20) { -1 }
  private var outputStream: OutputStream? = null
  private var socket: Socket? = null
  private var sequenceNumber = 0
  private var pendingWidth = 0
  private var pendingHeight = 0
  private var pendingTouchCount = 0
  private var hasPendingFrame = false
  private var sendLoopScheduled = false

  override fun getName(): String = "AdbTouch"

  @ReactMethod
  fun connect(port: Int, promise: Promise) {
    executor.execute {
      try {
        closeSocketInternal()

        val tcpSocket = Socket()
        tcpSocket.tcpNoDelay = true
        tcpSocket.keepAlive = true
        tcpSocket.connect(InetSocketAddress("127.0.0.1", port), 1500)

        socket = tcpSocket
        outputStream = tcpSocket.getOutputStream()
        sequenceNumber = 0

        emitStatus("connected", "Connected to 127.0.0.1:$port over ADB")
        promise.resolve(null)
      } catch (e: Exception) {
        closeSocketInternal()
        emitStatus("error", e.message ?: "ADB/TCP connect failed")
        promise.reject("ADB_CONNECT_FAILED", e)
      }
    }
  }

  @ReactMethod
  fun disconnect() {
    executor.execute {
      closeSocketInternal()
      emitStatus("disconnected", "Disconnected")
    }
  }

  @ReactMethod
  fun sendFrame(width: Int, height: Int, touchCount: Int, touches: ReadableArray) {
    val touchSlots = IntArray(20) { -1 }
    val limit = minOf(touches.size(), touchSlots.size)

    for (index in 0 until limit) {
      touchSlots[index] =
          if (touches.getType(index) == ReadableType.Number) {
            touches.getDouble(index).roundToInt()
          } else {
            -1
          }
    }

    synchronized(sendLock) {
      pendingWidth = width
      pendingHeight = height
      pendingTouchCount = touchCount.coerceIn(0, 10)
      touchSlots.copyInto(pendingTouches)
      hasPendingFrame = true

      if (sendLoopScheduled) {
        return
      }

      sendLoopScheduled = true
    }

    executor.execute { drainPendingFrames() }
  }

  override fun invalidate() {
    closeSocketInternal()
    executor.shutdownNow()
    super.invalidate()
  }

  private fun buildPacket(width: Int, height: Int, touchCount: Int, touches: IntArray) {
    packet.fill(0)
    packet[0] = 'R'.code.toByte()
    packet[1] = 'T'.code.toByte()
    packet[2] = 1
    packet[3] = touchCount.coerceIn(0, 10).toByte()

    writeU16(4, sequenceNumber)
    writeU16(6, width.coerceIn(0, 0xffff))
    writeU16(8, height.coerceIn(0, 0xffff))

    for (index in 0 until 10) {
      val touchOffset = 10 + index * 4
      val x = touches.getOrElse(index * 2) { -1 }
      val y = touches.getOrElse(index * 2 + 1) { -1 }
      writeI16(touchOffset, x)
      writeI16(touchOffset + 2, y)
    }

    sequenceNumber = (sequenceNumber + 1) and 0xffff
  }

  private fun drainPendingFrames() {
    val touches = IntArray(20)

    while (true) {
      val width: Int
      val height: Int
      val touchCount: Int

      synchronized(sendLock) {
        if (!hasPendingFrame) {
          sendLoopScheduled = false
          return
        }

        width = pendingWidth
        height = pendingHeight
        touchCount = pendingTouchCount
        pendingTouches.copyInto(touches)
        hasPendingFrame = false
      }

      val stream = outputStream ?: continue
      if (width <= 0 || height <= 0) {
        continue
      }

      try {
        buildPacket(width, height, touchCount, touches)
        stream.write(packet)
      } catch (e: Exception) {
        closeSocketInternal()
        emitStatus("error", e.message ?: "ADB/TCP send failed")
        return
      }
    }
  }

  private fun writeU16(offset: Int, value: Int) {
    packet[offset] = (value and 0xff).toByte()
    packet[offset + 1] = ((value ushr 8) and 0xff).toByte()
  }

  private fun writeI16(offset: Int, value: Int) {
    val clamped = value.coerceIn(-1, 32767)
    val normalized = if (clamped < 0) 0xffff else clamped
    writeU16(offset, normalized)
  }

  private fun emitStatus(type: String, message: String) {
    val payload = Arguments.createMap().apply {
      putString("type", type)
      putString("message", message)
    }

    reactContext
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit("AdbTouchStatus", payload)
  }

  private fun closeSocketInternal() {
    synchronized(sendLock) {
      hasPendingFrame = false
      sendLoopScheduled = false
    }

    try {
      outputStream?.close()
    } catch (_: IOException) {
    }

    try {
      socket?.close()
    } catch (_: IOException) {
    }

    outputStream = null
    socket = null
  }
}
