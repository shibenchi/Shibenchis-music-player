package com.shibenchi.musicplayer

import android.app.WallpaperColors
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.SystemClock
import android.service.wallpaper.WallpaperService
import android.text.TextPaint
import android.text.TextUtils
import android.view.SurfaceHolder
import androidx.core.graphics.ColorUtils
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.atomic.AtomicBoolean

// the live wallpaper of the phone: the visualizer of the app behind the icons of the home screen (and the lock screen, if the person
// picks it for that too). it is a normal android live wallpaper, picked on the system's own screen (the settings button opens it, the app
// cannot set it by itself).
//
// it plays no sound and reads none: the page already sends the mini player a frame of its audio analysis about thirty times a second
// while music plays (Viz, through SmpNative.vizFrame), and this draws the same frames across the whole screen. it is cheap on purpose:
// - it only draws while the wallpaper is on screen (the screen is off, an app covers the home screen: the page is told, through the
//   answer of vizFrame, and sends a frame only a few times a second)
// - it draws when a frame arrives, not on a timer, so a paused song costs nothing at all
// - when nothing plays it draws one still picture and stops
// - in the picker's preview, with nothing playing, it shows a moving sample so the person sees what it does
class SmpWallpaperService : WallpaperService() {
  override fun onCreateEngine(): Engine = SmpEngine()

  inner class SmpEngine : Engine() {
    @Volatile var visible = false
    @Volatile private var surfaceReady = false
    private var width = 0
    private var height = 0
    private val thread = HandlerThread("smp-wallpaper")
    @Volatile private lateinit var handler: Handler
    private val drawQueued = AtomicBoolean(false)
    private var lastDrawAt = 0L

    // the drawings (VizPainter) and what they are fed
    private val gfx = AndroidGfx()
    private val painter = VizPainter(gfx)
    private val input = VizInput()
    private var startedAt = 0L
    private var paintedAt = 0L
    private var fade = 0f
    private var sampleStart = 0L
    private val density = resources.displayMetrics.density

    // ---- the colors the system takes from this wallpaper (see WallpaperPalette). the system asks when the wallpaper is set, and again
    // after notifyColorsChanged. it re-colors the phone each time, so it is told once the theme color has stopped moving for a moment
    // (the color slider sends a new one every few tenths of a second) and never twice within 5 s
    private val mainHandler = Handler(Looper.getMainLooper())
    private var colorsKey = "" // the colors the system was told about last
    private var seenKey = "" // what the last look found
    private var changedAt = 0L // when the colors last changed
    private var colorsSentAt = 0L
    private val recheckColors = Runnable { checkColors() }

    @Suppress("NewApi")
    override fun onComputeColors(): WallpaperColors? {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O_MR1) return null
      val c = WallpaperPalette.colors()
      colorsKey = WallpaperPalette.key()
      return WallpaperColors(Color.valueOf(c[0]), Color.valueOf(c[1]), Color.valueOf(c[2]))
    }

    fun checkColors() {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O_MR1) return
      mainHandler.post {
        val key = WallpaperPalette.key()
        val now = SystemClock.elapsedRealtime()
        if (key != seenKey) {
          seenKey = key
          changedAt = now
        }
        if (key == colorsKey) {
          // the system already has these
          mainHandler.removeCallbacks(recheckColors)
          return@post
        }
        // told once the color has been still for a moment, and not within 5 s of the last time
        val wait = maxOf(changedAt + 1_200 - now, colorsSentAt + 5_000 - now)
        if (wait > 0) {
          mainHandler.removeCallbacks(recheckColors)
          mainHandler.postDelayed(recheckColors, wait)
          return@post
        }
        colorsSentAt = now
        try {
          notifyColorsChanged()
        } catch (e: Exception) {
          // the engine is going away
        }
      }
    }

    override fun onCreate(surfaceHolder: SurfaceHolder) {
      super.onCreate(surfaceHolder)
      thread.start()
      handler = Handler(thread.looper)
      engines.add(this)
    }

    override fun onDestroy() {
      engines.remove(this)
      mainHandler.removeCallbacks(recheckColors)
      visible = false
      thread.quitSafely()
      super.onDestroy()
    }

    override fun onVisibilityChanged(isVisible: Boolean) {
      visible = isVisible
      if (isVisible) {
        // the first picture: the last frame, or the still one
        requestDraw(true)
        if (isPreview) schedulePreview()
      }
    }

    override fun onSurfaceCreated(holder: SurfaceHolder) {
      super.onSurfaceCreated(holder)
      surfaceReady = true
    }

    override fun onSurfaceChanged(holder: SurfaceHolder, format: Int, w: Int, h: Int) {
      super.onSurfaceChanged(holder, format, w, h)
      width = w
      height = h
      surfaceReady = true
      requestDraw(true)
    }

    override fun onSurfaceDestroyed(holder: SurfaceHolder) {
      surfaceReady = false
      super.onSurfaceDestroyed(holder)
    }

    // asks for a drawing. at most one waits at a time, and two are at least 28 ms apart (about thirty a second)
    fun requestDraw(now: Boolean = false) {
      if (!visible || !surfaceReady || !::handler.isInitialized) return
      if (!drawQueued.compareAndSet(false, true)) return
      val wait = if (now) 0L else (lastDrawAt + 28 - SystemClock.elapsedRealtime()).coerceAtLeast(0L)
      handler.postDelayed({
        drawQueued.set(false)
        drawNow()
      }, wait)
    }

    // the preview in the picker shows a moving sample while nothing plays
    private fun schedulePreview() {
      if (!isPreview || !::handler.isInitialized) return
      handler.postDelayed({
        if (!visible) return@postDelayed
        if (!NowPlaying.playing) drawNow()
        schedulePreview()
      }, 40)
    }

    private fun drawNow() {
      if (!visible || !surfaceReady || width == 0 || height == 0) return
      val holder = surfaceHolder
      var canvas: Canvas? = null
      try {
        canvas = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) holder.lockHardwareCanvas() else holder.lockCanvas()
        if (canvas != null) paintFrame(canvas)
      } catch (e: Exception) {
        // the surface went away while drawing: the next drawing finds out
      } finally {
        try { if (canvas != null) holder.unlockCanvasAndPost(canvas) } catch (e: Exception) { /* gone */ }
      }
      lastDrawAt = SystemClock.elapsedRealtime()
    }

    private fun accentHue(): Float {
      val hsv = FloatArray(3)
      android.graphics.Color.colorToHSV(NowPlaying.accent, hsv)
      return hsv[0]
    }

    private fun hasSong() = NowPlaying.hasTrack && NowPlaying.title.isNotEmpty()

    private fun song() = VizSong(NowPlaying.title, NowPlaying.artist, NowPlaying.currentPositionMs() / 1000f, NowPlaying.durationMs / 1000f)

    // the page's drawings (VizPainter) across the whole screen, in the preset the app has picked, with the song on it in a place that fits the
    // drawing (VizInfo)
    private fun paintFrame(canvas: Canvas) {
      val w = width.toFloat()
      val h = height.toFloat()
      canvas.drawColor(0xFF0A0A0A.toInt())
      val now = SystemClock.elapsedRealtime()
      val frame = Viz.frame
      if (!NowPlaying.playing || frame == null || now - frame.at >= 700) {
        paintedAt = 0L
        fade = 0f
        if (isPreview) drawSample(canvas, w, h, now) else drawStill(canvas, w, h)
        return
      }
      if (startedAt == 0L) startedAt = now
      frame.fill(input)
      input.now = (now - startedAt).toFloat()
      input.dt = if (paintedAt == 0L) 33f else (now - paintedAt).coerceIn(4L, 100L).toFloat()
      paintedAt = now
      fade = Math.min(1f, fade + 0.1f * input.dt / 33f)
      input.fade = fade
      // the plain background has no drawing: the particles stand in for it
      val preset = if (frame.preset == "none") "particles" else frame.preset
      val song = hasSong()
      input.insetTop = if (song) VizPainter.insetTop(preset) else 0f
      input.insetCenter = if (song) VizPainter.insetCenter(preset) else 0.5f
      gfx.begin(canvas, density, w, h)
      try {
        painter.draw(preset, input)
        if (song) VizInfo.draw(gfx, preset, song(), frame.hue, 0.35f + 0.65f * fade, VizPainter.insetCenter(preset))
      } finally {
        gfx.end()
      }
    }

    // nothing plays: a quiet ring in the theme color, with the song that is loaded under it. drawn once, then nothing runs
    private fun drawStill(canvas: Canvas, w: Float, h: Float) {
      val hue = accentHue()
      gfx.begin(canvas, density, w, h)
      try {
        val cx = gfx.width / 2f
        val cy = gfx.height * 0.45f
        val r = Math.min(gfx.width, gfx.height) * 0.2f
        gfx.beginPath()
        gfx.oval(cx, cy, r, r)
        gfx.stroke(2f, VizColor.hsla(hue, 85f, 58f, 0.35f))
        gfx.beginPath()
        gfx.oval(cx, cy, r * 0.72f, r * 0.72f)
        gfx.oval(cx, cy, r * 0.44f, r * 0.44f)
        gfx.stroke(1f, VizColor.hsla(hue, 85f, 58f, 0.16f))
        gfx.circle(cx, cy, r * 0.16f, VizColor.hsla(hue, 85f, 58f, 0.43f))
        if (hasSong()) VizInfo.draw(gfx, "minimalPulse", song(), hue, 0.8f, 0.45f)
      } finally {
        gfx.end()
      }
    }

    // what the person sees in the picker when nothing plays: made up music at 120 beats a minute, and the drawings one after the other
    private fun drawSample(canvas: Canvas, w: Float, h: Float, now: Long) {
      if (sampleStart == 0L) sampleStart = now
      val t = (now - sampleStart).toFloat()
      val beat = (t / 500f).toInt()
      val phase = (t % 500f) / 500f
      val kick = Math.exp((-phase * 5f).toDouble()).toFloat()
      val presets = VizPainter.PRESETS
      val preset = presets[((t / 5000f).toInt()) % presets.size]
      input.hue = accentHue()
      input.playing = true
      input.fade = 1f
      input.bass = kick
      input.soft = 0.35f + 0.25f * Math.sin((t / 900f).toDouble()).toFloat()
      input.beat = kick
      input.bar = if (beat % 4 == 0) kick else 0f
      input.bpm = 120f
      input.locked = true
      input.phase = phase
      input.period = 500f
      input.beatCount = beat
      input.barCount = beat / 4
      input.beatInBar = beat % 4
      input.volume = 0.5f
      input.spec = FloatArray(96) { i ->
        val base = 0.12f + 0.45f * Math.exp((-i / 30.0)).toFloat()
        val wobble = 0.65f + 0.35f * Math.abs(Math.sin(i / 5.0 + t / 400.0)).toFloat()
        (base * wobble + kick * 0.35f * Math.exp((-i / 14.0)).toFloat()).coerceIn(0f, 1f)
      }
      input.wave = FloatArray(96) { i -> Math.sin(i / 6.0 + t / 120.0).toFloat() * 0.4f * (1f + kick) }
      input.level = input.spec[0]
      input.now = t
      input.dt = if (paintedAt == 0L) 33f else (now - paintedAt).coerceIn(4L, 100L).toFloat()
      paintedAt = now
      input.insetTop = 0f
      input.insetCenter = 0.5f
      gfx.begin(canvas, density, w, h)
      try {
        painter.draw(preset, input)
      } finally {
        gfx.end()
      }
    }
  }

  companion object {
    private val engines = CopyOnWriteArraySet<SmpEngine>()

    // the wallpaper is on screen right now (home screen, lock screen or the picker's preview)
    fun isShowing(): Boolean = engines.any { it.visible }

    // a frame arrived, or what is playing changed
    fun poke() {
      engines.forEach { it.requestDraw() }
    }

    // the song, its cover or the theme color may be different: the system is told if the colors of the wallpaper are
    fun colorsMayHaveChanged() {
      engines.forEach { it.checkColors() }
    }

    // on: the person picked it as their wallpaper. off: something else is. empty: this phone has no live wallpapers
    fun status(context: Context): String {
      if (!context.packageManager.hasSystemFeature(android.content.pm.PackageManager.FEATURE_LIVE_WALLPAPER)) return ""
      val info = try {
        android.app.WallpaperManager.getInstance(context).wallpaperInfo
      } catch (e: Exception) {
        null
      }
      return if (info != null && info.packageName == context.packageName && info.serviceName == SmpWallpaperService::class.java.name) "on" else "off"
    }

    // opens the system's own screen for this wallpaper (a preview and a button to set it). nothing is set without the person
    // pressing that button
    fun openPicker(context: Context): Boolean {
      return try {
        val intent = android.content.Intent(android.app.WallpaperManager.ACTION_CHANGE_LIVE_WALLPAPER)
          .putExtra(android.app.WallpaperManager.EXTRA_LIVE_WALLPAPER_COMPONENT, android.content.ComponentName(context, SmpWallpaperService::class.java))
          .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        true
      } catch (e: Exception) {
        // some phones do not have the direct screen: the list of live wallpapers
        try {
          context.startActivity(android.content.Intent(android.app.WallpaperManager.ACTION_LIVE_WALLPAPER_CHOOSER).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK))
          true
        } catch (e2: Exception) {
          false
        }
      }
    }
  }
}
