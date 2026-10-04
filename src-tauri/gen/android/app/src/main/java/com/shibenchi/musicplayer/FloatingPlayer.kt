package com.shibenchi.musicplayer

import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.text.TextUtils
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewOutlineProvider
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.graphics.ColorUtils

// the mini player of the phone. it floats over other apps while music plays and the
// app is not on screen, and it is the app's own window: drawn here, with the app's
// own buttons and seek bar, and it takes touches. android's picture in picture
// window was used before and cannot be made the app's own, the system always draws
// its controls over it. this needs the "display over other apps" permission, which
// the mini player setting asks for. without it there is no mini player on the phone
object FloatingPlayer {
  private val main = Handler(Looper.getMainLooper())
  @Volatile private var card: FloatingCard? = null
  private var receiverAdded = false

  // the app is on screen, nothing floats then
  @Volatile var appVisible = false
  // closed with the x: stays closed until the app has been opened again
  @Volatile private var closedByUser = false

  fun isShowing() = card != null

  private fun prefs(context: Context) = context.getSharedPreferences("smp_float", Context.MODE_PRIVATE)

  fun isEnabled(context: Context) = prefs(context).getBoolean("enabled", true)

  fun setEnabled(context: Context, on: Boolean) {
    prefs(context).edit().putBoolean("enabled", on).apply()
    if (!on) hide()
  }

  fun canDraw(context: Context) = Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(context)

  fun ready(context: Context) = isEnabled(context) && canDraw(context)

  // what the settings page shows: ready, needs_permission or off
  fun status(context: Context) = when {
    !isEnabled(context) -> "off"
    !canDraw(context) -> "needs_permission"
    else -> "ready"
  }

  private fun interactive(context: Context) =
    context.getSystemService(PowerManager::class.java)?.isInteractive != false

  // the app came to the front
  fun onAppShown() {
    appVisible = true
    closedByUser = false
    hide()
  }

  // the app left the front (home, another app). floats if music is playing
  fun onAppLeft(context: Context) {
    appVisible = false
    watchUnlock(context)
    sync(context)
  }

  // called whenever the page reports a change: floats when the app is not on screen
  // and something plays, goes away with the track
  fun sync(context: Context) {
    val app = context.applicationContext
    if (!NowPlaying.hasTrack) {
      hide()
      return
    }
    if (appVisible || closedByUser || !NowPlaying.playing || !ready(app) || !interactive(app)) return
    show(app)
  }

  // the phone being unlocked while music plays in the background brings it back
  private fun watchUnlock(context: Context) {
    if (receiverAdded) return
    receiverAdded = true
    val app = context.applicationContext
    val receiver = object : BroadcastReceiver() {
      override fun onReceive(c: Context, intent: Intent) = sync(app)
    }
    val filter = IntentFilter(Intent.ACTION_USER_PRESENT)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) app.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
    else app.registerReceiver(receiver, filter)
  }

  fun show(app: Context) {
    main.post {
      if (card != null) return@post
      try {
        val wm = app.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val view = FloatingCard(app)
        val params = view.windowParams()
        view.params = params
        wm.addView(view, params)
        card = view
        view.refresh(true)
        main.removeCallbacks(ticker)
        main.postDelayed(ticker, 60)
      } catch (e: Exception) {
        Log.w("SmpFloat", "could not show the mini player: ${e.message}")
        card = null
      }
    }
  }

  fun hide() {
    main.post {
      main.removeCallbacks(ticker)
      val view = card ?: return@post
      card = null
      try {
        (view.context.getSystemService(Context.WINDOW_SERVICE) as WindowManager).removeView(view)
      } catch (e: Exception) {
        // already gone
      }
    }
  }

  fun closeByUser() {
    closedByUser = true
    hide()
  }

  // the mini player drawn into a picture (png, base64) without showing it, so how it
  // looks can be checked without the permission to float. with some made up audio
  // when there is none
  fun preview(context: Context): String {
    val app = context.applicationContext
    var out = "no picture"
    val latch = java.util.concurrent.CountDownLatch(1)
    main.post {
      try {
        if (Viz.frame == null) {
          Viz.frame = VizFrame(NowPlaying.accent.let { c -> val hsv = FloatArray(3); Color.colorToHSV(c, hsv); hsv[0] }, 0.4f, false,
            IntArray(24) { i -> 60 + ((Math.sin(i / 3.0) + 1) * 80).toInt() }, IntArray(96) { i -> 128 + (Math.sin(i / 6.0) * 60).toInt() }, android.os.SystemClock.elapsedRealtime())
        }
        val view = FloatingCard(app)
        view.refresh(true)
        // measured the way the window is: the card sets its own fixed size
        view.measure(View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED), View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED))
        view.layout(0, 0, view.measuredWidth, view.measuredHeight)
        val bitmap = Bitmap.createBitmap(view.measuredWidth, view.measuredHeight, Bitmap.Config.ARGB_8888)
        Viz.forceDraw = true
        view.draw(Canvas(bitmap))
        Viz.forceDraw = false
        val bytes = java.io.ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, bytes)
        out = android.util.Base64.encodeToString(bytes.toByteArray(), android.util.Base64.NO_WRAP)
      } catch (e: Exception) {
        out = "error: ${e.message}"
      } finally {
        latch.countDown()
      }
    }
    latch.await(4, java.util.concurrent.TimeUnit.SECONDS)
    return out
  }

  private val ticker = object : Runnable {
    override fun run() {
      val view = card ?: return
      if (!NowPlaying.hasTrack) {
        hide()
        return
      }
      view.refresh(false)
      main.postDelayed(this, if (NowPlaying.playing) 60 else 500)
    }
  }
}

// one frame of the page's audio analysis, handed over by the page a few times a second
// while the mini player shows: 24 bars, 96 points of the waveform, the theme hue and
// how hard the bass is hitting
class VizFrame(val hue: Float, val bass: Float, val wave: Boolean, val bins: IntArray, val points: IntArray, val at: Long)

object Viz {
  @Volatile var frame: VizFrame? = null
  // only while the mini player is drawn into a picture to look at
  @Volatile var forceDraw = false

  // "hue,bass,wave;b0,b1,...;w0,w1,..."
  fun parse(text: String) {
    try {
      val parts = text.split(';')
      if (parts.size < 3) return
      val head = parts[0].split(',')
      val bins = parts[1].split(',').map { it.trim().toIntOrNull() ?: 0 }.toIntArray()
      val points = parts[2].split(',').map { it.trim().toIntOrNull() ?: 128 }.toIntArray()
      frame = VizFrame(
        head[0].toFloatOrNull() ?: 0f,
        head.getOrNull(1)?.toFloatOrNull() ?: 0f,
        head.getOrNull(2) == "1",
        bins, points, android.os.SystemClock.elapsedRealtime()
      )
    } catch (e: Exception) {
      // a bad frame is just skipped
    }
  }
}

// the visualizer behind the controls, the same bars and wave the desktop mini player draws
internal class FloatingViz(context: Context) : View(context) {
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val path = Path()
  private val corners = Path()
  private val density = resources.displayMetrics.density
  // what is drawn eases towards the latest frame on every screen refresh, so the
  // bars and the wave move smoothly even though the page only sends a frame about
  // thirty times a second
  private var shownBins = FloatArray(0)
  private var shownPoints = FloatArray(0)
  private var shownBass = 0f

  private fun softCeiling(x: Float) = if (x <= 0.65f) x else 0.65f + 0.35f * Math.tanh(((x - 0.65f) / 0.35f).toDouble()).toFloat()

  override fun onDraw(canvas: Canvas) {
    val f = Viz.frame ?: return
    if (!Viz.forceDraw && (!NowPlaying.playing || android.os.SystemClock.elapsedRealtime() - f.at > 700)) {
      shownBins = FloatArray(0)
      shownPoints = FloatArray(0)
      return
    }
    // ease towards the frame (the first one is taken as it is)
    if (shownBins.size != f.bins.size) shownBins = FloatArray(f.bins.size) { f.bins[it].toFloat() }
    if (shownPoints.size != f.points.size) shownPoints = FloatArray(f.points.size) { f.points[it].toFloat() }
    for (i in shownBins.indices) shownBins[i] += (f.bins[i] - shownBins[i]) * 0.55f
    for (i in shownPoints.indices) shownPoints[i] += (f.points[i] - shownPoints[i]) * 0.6f
    shownBass += (f.bass - shownBass) * 0.55f
    if (!Viz.forceDraw) postInvalidateOnAnimation()
    val w = width.toFloat()
    val h = height.toFloat()
    // cut to the rounded corners of the card by hand. a window that is not hardware
    // drawn ignores clipToOutline, and the bars poked out of the bottom corners
    corners.reset()
    val radius = 11f * density
    corners.addRoundRect(RectF(0f, 0f, w, h), radius, radius, Path.Direction.CW)
    canvas.clipPath(corners)
    val color = ColorUtils.HSLToColor(floatArrayOf(((f.hue % 360f) + 360f) % 360f, 0.85f, 0.58f))
    if (f.wave && f.points.size > 1) {
      val mid = h / 2f
      val swing = mid * 0.8f * (1f + shownBass * 0.9f)
      val step = w / (shownPoints.size - 1)
      path.reset()
      for (i in shownPoints.indices) {
        val y = mid + ((shownPoints[i] - 128f) / 128f) * swing
        if (i == 0) path.moveTo(0f, y) else path.lineTo(i * step, y)
      }
      paint.style = Paint.Style.STROKE
      paint.strokeJoin = Paint.Join.ROUND
      paint.strokeWidth = (6f + shownBass * 6f) * density
      paint.shader = null
      paint.color = ColorUtils.setAlphaComponent(color, 46)
      canvas.drawPath(path, paint)
      paint.strokeWidth = 2f * density
      paint.color = ColorUtils.setAlphaComponent(color, 204)
      canvas.drawPath(path, paint)
    } else if (f.bins.isNotEmpty()) {
      val count = f.bins.size
      val gap = 2f * density
      val barWidth = w / count - gap
      paint.style = Paint.Style.FILL
      paint.shader = LinearGradient(0f, h, 0f, 0f, ColorUtils.setAlphaComponent(color, 150), ColorUtils.setAlphaComponent(color, 30), Shader.TileMode.CLAMP)
      for (i in 0 until count) {
        val bassWeight = Math.max(0f, 1f - i / (count * 0.3f))
        val boosted = softCeiling((shownBins[i] / 255f) * (1f + shownBass * bassWeight * 2.5f))
        val barHeight = Math.max(2f * density, boosted * h * 0.85f)
        val x = i * (barWidth + gap)
        canvas.drawRect(RectF(x, h - barHeight, x + barWidth, h), paint)
      }
      paint.shader = null
    }
  }
}

// a button drawn from one of the app's own icons
internal class IconButton(context: Context, size: Int, pad: Int) : ImageView(context) {
  init {
    scaleType = ScaleType.CENTER_INSIDE
    layoutParams = LinearLayout.LayoutParams(size, size)
    setPadding(pad, pad, pad, pad)
  }

  // SRC_IN: the icon takes the color as it is, with its transparency (the plain
  // setColorFilter(color) paints over the icon and a dim color came out solid)
  fun tint(color: Int) = setColorFilter(color, android.graphics.PorterDuff.Mode.SRC_IN)
  fun show(resource: Int) = setImageResource(resource)
}

// the x and the "open the app" arrow, drawn by hand so there is nothing to ship
internal class GlyphButton(context: Context, private val kind: Int, private val size: Int) : View(context) {
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    strokeCap = Paint.Cap.ROUND
    strokeWidth = size * 0.075f
  }

  init {
    layoutParams = LinearLayout.LayoutParams(size, size)
  }

  fun tint(color: Int) {
    paint.color = color
    invalidate()
  }

  override fun onDraw(canvas: Canvas) {
    val m = size * 0.3f
    val e = size - m
    if (kind == 0) {
      canvas.drawLine(m, m, e, e, paint)
      canvas.drawLine(e, m, m, e, paint)
    } else {
      // an arrow pointing out of a corner: open the app
      canvas.drawLine(m, e, e, m, paint)
      canvas.drawLine(e - size * 0.28f, m, e, m, paint)
      canvas.drawLine(e, m, e, m + size * 0.28f, paint)
    }
  }
}

// the seek bar. it takes the finger itself so dragging along it does not move the card
internal class FloatingSeek(context: Context) : View(context) {
  var fraction = 0f
  var accent = Color.WHITE
  var dragging = false
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val density = resources.displayMetrics.density

  private fun fractionAt(x: Float) = ((x - paddingLeft) / (width - paddingLeft - paddingRight).coerceAtLeast(1)).coerceIn(0f, 1f)

  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(event: MotionEvent): Boolean {
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        parent?.requestDisallowInterceptTouchEvent(true)
        dragging = true
        fraction = fractionAt(event.x)
        invalidate()
      }
      MotionEvent.ACTION_MOVE -> {
        fraction = fractionAt(event.x)
        invalidate()
      }
      MotionEvent.ACTION_UP -> {
        dragging = false
        fraction = fractionAt(event.x)
        invalidate()
        if (NowPlaying.durationMs > 0) {
          context.sendBroadcast(
            Intent(context, MediaActionReceiver::class.java)
              .setAction(MediaActionReceiver.ACTION_SEEK)
              .setPackage(context.packageName)
              .putExtra("percent", fraction.toDouble())
          )
        }
      }
      MotionEvent.ACTION_CANCEL -> dragging = false
    }
    return true
  }

  override fun onDraw(canvas: Canvas) {
    val left = paddingLeft.toFloat()
    val right = (width - paddingRight).toFloat()
    val mid = height / 2f
    val h = 4f * density
    paint.style = Paint.Style.FILL
    paint.color = 0x26FFFFFF
    canvas.drawRoundRect(RectF(left, mid - h / 2, right, mid + h / 2), h / 2, h / 2, paint)
    val x = left + (right - left) * fraction
    paint.color = accent
    canvas.drawRoundRect(RectF(left, mid - h / 2, x, mid + h / 2), h / 2, h / 2, paint)
    if (dragging) canvas.drawCircle(x, mid, 6f * density, paint)
  }
}

// the window: the theme colored outline with the card inside it, the same as the
// picture in picture version looked, with the same controls
internal class FloatingCard(context: Context) : FrameLayout(context) {
  var params: WindowManager.LayoutParams? = null

  private val density = resources.displayMetrics.density
  private fun dp(v: Float) = (v * density).toInt()

  private val outline = GradientDrawable().apply { cornerRadius = 14f * density }
  private val inner = FrameLayout(context)
  private val viz = FloatingViz(context)
  private val art = ImageView(context)
  private val title = TextView(context)
  private val artist = TextView(context)
  private val elapsed = TextView(context)
  private val total = TextView(context)
  private val seek = FloatingSeek(context)
  private val shuffle = IconButton(context, dp(36f), dp(8f))
  private val prev = IconButton(context, dp(38f), dp(8f))
  private val play = IconButton(context, dp(42f), dp(9f))
  private val next = IconButton(context, dp(38f), dp(8f))
  private val repeat = IconButton(context, dp(36f), dp(8f))
  private val mute = IconButton(context, dp(36f), dp(8f))
  private val close = GlyphButton(context, 0, dp(28f))
  private val open = GlyphButton(context, 1, dp(28f))

  private var shownTitle: String? = null
  private var shownArtist: String? = null
  private var shownThumb: String? = null
  private var shownPlaying: Boolean? = null
  private var shownShuffle: Boolean? = null
  private var shownRepeat = -1
  private var shownMuted: Boolean? = null
  private var shownAccent = 0
  private var loadingThumb = ""

  init {
    background = outline
    elevation = 8f * density

    // the card inside the outline. its rounded corners clip what is drawn inside it
    // (the visualizer), so nothing pokes out of the corners
    inner.background = GradientDrawable().apply {
      cornerRadius = 11f * density
      setColor(0xFF0A0A0A.toInt())
    }
    inner.clipToOutline = true
    inner.outlineProvider = ViewOutlineProvider.BACKGROUND
    val margin = dp(3f)
    addView(inner, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT).apply {
      setMargins(margin, margin, margin, margin)
    })

    // the card has a fixed size (see onMeasure), the controls sit in the middle of it
    val column = LinearLayout(context).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding(dp(14f), dp(4f), dp(14f), dp(4f))
    }
    inner.addView(viz, FrameLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    inner.addView(column, FrameLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))

    // the picture, the names and the buttons for opening the app and closing this
    val top = LinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
    }
    art.layoutParams = LinearLayout.LayoutParams(dp(40f), dp(40f))
    top.addView(art)
    val names = LinearLayout(context).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(dp(11f), 0, dp(4f), 0)
    }
    title.apply {
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
      typeface = Typeface.DEFAULT_BOLD
      setTextColor(0xFFFEF3E2.toInt())
      setSingleLine()
      ellipsize = TextUtils.TruncateAt.MARQUEE
      marqueeRepeatLimit = -1
      isSelected = true
    }
    artist.apply {
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
      setTextColor(0xB3FEF3E2.toInt())
      setSingleLine()
      ellipsize = TextUtils.TruncateAt.END
    }
    names.addView(title)
    names.addView(artist)
    top.addView(names, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
    top.addView(open)
    top.addView(close)
    column.addView(top)

    // the time, the seek bar and the length on one line
    val bar = LinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
    }
    for (t in listOf(elapsed, total)) {
      t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10f)
      t.setTextColor(0xB3FEF3E2.toInt())
    }
    elapsed.minWidth = dp(30f)
    total.minWidth = dp(30f)
    total.gravity = Gravity.END
    bar.addView(elapsed)
    seek.setPadding(dp(6f), 0, dp(6f), 0)
    bar.addView(seek, LinearLayout.LayoutParams(0, dp(26f), 1f))
    bar.addView(total)
    column.addView(bar, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))

    // shuffle, previous, play or pause, next, repeat, mute
    val buttons = LinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER
    }
    shuffle.show(R.drawable.ic_shuffle)
    prev.show(R.drawable.ic_prev)
    next.show(R.drawable.ic_next)
    for (b in listOf(shuffle, prev, play, next, repeat, mute)) buttons.addView(b)
    column.addView(buttons, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))

    shuffle.setOnClickListener { send(MediaActionReceiver.ACTION_SHUFFLE) }
    prev.setOnClickListener { send(MediaActionReceiver.ACTION_PREV) }
    play.setOnClickListener { send(MediaActionReceiver.ACTION_TOGGLE) }
    next.setOnClickListener { send(MediaActionReceiver.ACTION_NEXT) }
    repeat.setOnClickListener { send(MediaActionReceiver.ACTION_REPEAT) }
    mute.setOnClickListener { send(MediaActionReceiver.ACTION_MUTE) }
    close.setOnClickListener { FloatingPlayer.closeByUser() }
    open.setOnClickListener {
      try {
        context.startActivity(launchIntent(context))
      } catch (e: Exception) {
        Log.w("SmpFloat", "could not open the app: ${e.message}")
      }
    }
  }

  private fun send(action: String) {
    context.sendBroadcast(Intent(context, MediaActionReceiver::class.java).setAction(action).setPackage(context.packageName))
    refresh(false)
  }

  @Suppress("DEPRECATION")
  private val phoneType = WindowManager.LayoutParams.TYPE_PHONE

  // 300 by 150, the same shape as the mini player on the pc. a window that wraps its
  // content gets the whole screen height offered to it and the visualizer behind the
  // controls stretched to fill it, so the size is fixed here instead
  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    super.onMeasure(
      MeasureSpec.makeMeasureSpec(dp(CARD_WIDTH), MeasureSpec.EXACTLY),
      MeasureSpec.makeMeasureSpec(dp(CARD_HEIGHT), MeasureSpec.EXACTLY)
    )
  }

  fun windowParams(): WindowManager.LayoutParams {
    val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY else phoneType
    val lp = WindowManager.LayoutParams(
      dp(CARD_WIDTH), dp(CARD_HEIGHT), type,
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
      PixelFormat.TRANSLUCENT
    )
    lp.gravity = Gravity.TOP or Gravity.START
    val prefs = context.getSharedPreferences("smp_float", Context.MODE_PRIVATE)
    val screen = context.resources.displayMetrics
    // a place saved with an older, taller card or a different screen is pulled back on screen
    lp.x = prefs.getInt("x", screen.widthPixels - dp(CARD_WIDTH) - dp(12f)).coerceIn(0, (screen.widthPixels - dp(CARD_WIDTH)).coerceAtLeast(0))
    lp.y = prefs.getInt("y", (screen.heightPixels * 0.55f).toInt()).coerceIn(0, (screen.heightPixels - dp(CARD_HEIGHT)).coerceAtLeast(0))
    return lp
  }

  companion object {
    const val CARD_WIDTH = 300f
    const val CARD_HEIGHT = 150f
  }

  // the card follows a finger that starts on it anywhere the buttons are not
  private var downRawX = 0f
  private var downRawY = 0f
  private var downX = 0
  private var downY = 0

  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(event: MotionEvent): Boolean {
    val lp = params ?: return false
    val wm = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        downRawX = event.rawX
        downRawY = event.rawY
        downX = lp.x
        downY = lp.y
      }
      MotionEvent.ACTION_MOVE -> {
        val screen = context.resources.displayMetrics
        lp.x = (downX + (event.rawX - downRawX)).toInt().coerceIn(0, (screen.widthPixels - width).coerceAtLeast(0))
        lp.y = (downY + (event.rawY - downRawY)).toInt().coerceIn(0, (screen.heightPixels - height).coerceAtLeast(0))
        try {
          wm.updateViewLayout(this, lp)
        } catch (e: Exception) {
          // the window went away under the finger
        }
      }
      MotionEvent.ACTION_UP -> {
        context.getSharedPreferences("smp_float", Context.MODE_PRIVATE).edit().putInt("x", lp.x).putInt("y", lp.y).apply()
      }
    }
    return true
  }

  private fun clock(ms: Long): String {
    val s = (ms / 1000).coerceAtLeast(0)
    return "%d:%02d".format(s / 60, s % 60)
  }

  // draws what is playing now. only what changed is touched, this runs many times
  // a second for the visualizer
  fun refresh(force: Boolean) {
    val accent = NowPlaying.accent
    val dim = 0x59FFFFFF
    if (force || accent != shownAccent) {
      shownAccent = accent
      outline.setColor(accent)
      prev.tint(accent)
      play.tint(accent)
      next.tint(accent)
      close.tint(accent)
      open.tint(accent)
      seek.accent = accent
      shownThumb = null
      shownShuffle = null
      shownRepeat = -1
      shownMuted = null
    }
    val name = NowPlaying.title.ifEmpty { "nothing playing" }
    if (force || name != shownTitle) {
      shownTitle = name
      title.text = name
      title.isSelected = true
    }
    if (force || NowPlaying.artist != shownArtist) {
      shownArtist = NowPlaying.artist
      artist.text = NowPlaying.artist
    }
    if (force || NowPlaying.playing != shownPlaying) {
      shownPlaying = NowPlaying.playing
      play.show(if (NowPlaying.playing) R.drawable.ic_pause else R.drawable.ic_play)
    }
    if (force || NowPlaying.shuffle != shownShuffle) {
      shownShuffle = NowPlaying.shuffle
      shuffle.tint(if (NowPlaying.shuffle) accent else dim)
    }
    if (force || NowPlaying.repeat != shownRepeat) {
      shownRepeat = NowPlaying.repeat
      repeat.show(if (NowPlaying.repeat == 2) R.drawable.ic_repeat_one else R.drawable.ic_repeat)
      repeat.tint(if (NowPlaying.repeat == 0) dim else accent)
    }
    if (force || NowPlaying.muted != shownMuted) {
      shownMuted = NowPlaying.muted
      mute.show(if (NowPlaying.muted) R.drawable.ic_volume_off else R.drawable.ic_volume_up)
      mute.tint(if (NowPlaying.muted) dim else accent)
    }
    val thumb = NowPlaying.thumbnail
    if (force || thumb != shownThumb) {
      shownThumb = thumb
      val cached = ArtLoader.cached(thumb)
      art.setImageBitmap(ArtLoader.record(cached, accent, dp(40f)))
      if (cached == null && thumb.isNotEmpty() && loadingThumb != thumb) {
        loadingThumb = thumb
        Thread {
          ArtLoader.load(thumb)
          post {
            loadingThumb = ""
            if (thumb == NowPlaying.thumbnail) refresh(true)
          }
        }.start()
      }
    }
    val duration = NowPlaying.durationMs
    val position = NowPlaying.currentPositionMs()
    if (!seek.dragging) {
      seek.fraction = if (duration > 0) (position.toFloat() / duration).coerceIn(0f, 1f) else 0f
      seek.invalidate()
    }
    elapsed.text = clock(if (seek.dragging && duration > 0) (duration * seek.fraction).toLong() else position)
    total.text = if (duration > 0) clock(duration) else "--:--"
    viz.invalidate()
  }
}
