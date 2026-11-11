package com.shibenchi.musicplayer

import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.math.tanh

// the drawings of the app's background (src/vizRenderers.js), for the phone: the live wallpaper and the floating mini player draw these, so
// they look like the app and have the same variations (bars, wave, radial, particles ...). it is a port of the page's drawings, keep the two
// in step when one changes.
//
// this file knows nothing about android: it draws through Gfx (AndroidGfx.kt is the canvas version, and the checks on a computer draw into a
// picture with the same code). all sizes are in the same units the page uses (css pixels): the canvas is scaled before it gets here, so a
// line that is 3.5 wide is 3.5 on the page and on the phone

interface Gfx {
  val width: Float
  val height: Float
  fun rect(x: Float, y: Float, w: Float, h: Float, color: Int)
  fun circle(cx: Float, cy: Float, r: Float, color: Int)
  // a disc filled with a radial gradient, the colors at the stops (0 in the middle, 1 at the rim)
  fun discGradient(cx: Float, cy: Float, r: Float, stops: FloatArray, colors: IntArray)
  // a rectangle filled with a vertical gradient that runs from y0 to y1 (colors at the stops)
  fun rectGradientV(x: Float, y: Float, w: Float, h: Float, y0: Float, y1: Float, stops: FloatArray, colors: IntArray)
  // a rectangle filled with a radial gradient round (cx, cy)
  fun rectGradientRadial(x: Float, y: Float, w: Float, h: Float, cx: Float, cy: Float, r: Float, stops: FloatArray, colors: IntArray)
  fun beginPath()
  fun moveTo(x: Float, y: Float)
  fun lineTo(x: Float, y: Float)
  fun quadTo(cx: Float, cy: Float, x: Float, y: Float)
  fun oval(cx: Float, cy: Float, rx: Float, ry: Float)
  fun closePath()
  fun fill(color: Int)
  fun stroke(lineWidth: Float, color: Int)
  fun line(x1: Float, y1: Float, x2: Float, y2: Float, lineWidth: Float, color: Int)
  fun save()
  fun restore()
  fun clipRect(x: Float, y: Float, w: Float, h: Float)
  fun rotate(radians: Float, px: Float, py: Float)
  // draws on a layer of its own at 1/reduce of the size, makes it softer by halving it twice and stretches it up over the picture: a strong blur, cheap
  fun blurLayer(reduce: Float, draw: (Gfx) -> Unit)
  // align: 0 left, 1 center, 2 right. y is the baseline
  fun text(s: String, x: Float, y: Float, size: Float, bold: Boolean, align: Int, color: Int)
  fun textWidth(s: String, size: Float, bold: Boolean): Float
}

// what a picture of the sound looks like, filled in by whoever draws (the wallpaper, the mini player)
class VizInput {
  var hue = 20f
  // the theme color's own saturation and lightness (0 to 100). themed is false when the frame did not carry them: the drawings then keep
  // the numbers written in them (see VizPainter.hsla)
  var sat = 100f
  var light = 54f
  var themed = false
  var playing = false
  // 0 to 1: how far the fade in of the drawing has come
  var fade = 1f
  // the strength of the last hit (the page's bassPulse), the slow pulse, the beat and bar envelopes
  var bass = 0f
  var soft = 0f
  var beat = 0f
  var bar = 0f
  var bpm = 0f
  var locked = false
  var phase = 0f
  var period = 0f
  var beatCount = 0
  var barCount = 0
  var beatInBar = 0
  var volume = 0f
  var level = 0f
  // 96 log spaced bars, 0 to 1
  var spec = FloatArray(96)
  // the waveform, -1 to 1, a few smooth swings (empty: none)
  var wave = FloatArray(0)
  var now = 0f
  var dt = 33f
  // what the drawing leaves free for the song information (a share of the height; see VizInfo)
  var insetTop = 0f
  var insetCenter = 0.5f
}

object VizColor {
  // like the page's hsla(): h degrees, s and l 0 to 100, a 0 to 1
  fun hsla(h: Float, s: Float, l: Float, a: Float): Int {
    val hh = (((h % 360f) + 360f) % 360f) / 360f
    val ss = (s / 100f).coerceIn(0f, 1f)
    val ll = (l / 100f).coerceIn(0f, 1f)
    val q = if (ll < 0.5f) ll * (1f + ss) else ll + ss - ll * ss
    val p = 2f * ll - q
    fun channel(t0: Float): Int {
      var t = t0
      if (t < 0f) t += 1f
      if (t > 1f) t -= 1f
      val v = when {
        t < 1f / 6f -> p + (q - p) * 6f * t
        t < 0.5f -> q
        t < 2f / 3f -> p + (q - p) * (2f / 3f - t) * 6f
        else -> p
      }
      return (v * 255f + 0.5f).toInt().coerceIn(0, 255)
    }
    val r = channel(hh + 1f / 3f)
    val g = channel(hh)
    val b = channel(hh - 1f / 3f)
    val alpha = (a.coerceIn(0f, 1f) * 255f + 0.5f).toInt()
    return (alpha shl 24) or (r shl 16) or (g shl 8) or b
  }
}

class VizPainter(private val g: Gfx, seed: Long = 7L) {
  private val rnd = java.util.Random(seed)
  private val lohi24 = FloatArray(2) { Float.NaN }
  private val lohiWall = FloatArray(2) { Float.NaN }
  private var presetKey = ""

  // ---- scratch state of the active drawing, made again whenever the drawing changes
  private class FallingBars(n: Int) {
    val v = FloatArray(n)
    val peak = FloatArray(n)
    val hold = FloatArray(n)
    val vel = FloatArray(n)
  }

  private class Hits(n: Int) {
    val prev = FloatArray(n)
    var mean = 0f
    var spread = 0f
    var last = -9999f
    var seen = 0
  }

  private class Dot(var x: Float, var y: Float, var vx: Float, var vy: Float, val baseRadius: Float, var radius: Float, val hueOffset: Float, var alpha: Float, val targetAlpha: Float, var kx: Float = 0f, var ky: Float = 0f)

  private class Star(var x: Float, var y: Float, var z: Float)

  private class Echo(var life: Float, val strength: Float, val shape: FloatArray, val angle: Float, val mean: Float)

  private class Ripple(var life: Float, val strength: Float, val x: Float)

  private class Pulse(var d: Float, val strength: Float)

  private class Ring(val k: Int, val z: Float, val glow: Float, val px: FloatArray, val py: FloatArray, val levels: FloatArray)

  private val falling = HashMap<String, FallingBars>()
  private val hits = HashMap<String, Hits>()
  private var dots: Array<Dot>? = null
  private var stars: Array<Star>? = null
  private var starsFor = 0f
  private var radialAngle = 0f
  private var globeSpin = 0f
  private var echoes = ArrayList<Echo>()
  private var lastBeatNo = Int.MIN_VALUE
  private var lastBarNo = Int.MIN_VALUE
  private var waterT = 0f
  private var ripples = ArrayList<Ripple>()
  private var mirrorHeights = FloatArray(0)
  // the tunnel
  private var tunT = TUN_AHEAD + 2f
  private var tunNewest = floor((TUN_AHEAD + 2f) / TUN_SPACING).toInt() - 1
  private var tunSpeed = 0.5f
  private var tunLoud = 0f
  private var tunGlow = 0f
  private var tunGlowShown = 0f
  private val tunLit = Array(TUN_RINGS) { FloatArray(TUN_BANDS) }
  private val tunLitGlow = FloatArray(TUN_RINGS)
  private var tunLastBeat = Int.MIN_VALUE
  private var tunLastBar = Int.MIN_VALUE
  private var tunLockOff = Float.NaN
  private var tunLockStride = 0
  private var tunErr = 0f
  private var tunClock = 0f
  private var tunLockedAt = -1000f
  private var tunLastPeriod = 0f
  private val tunLight = FloatArray(TUN_BANDS)
  private val tunWall = FloatArray(TUN_WALL)
  private val tunRaw24 = FloatArray(24)
  private val tunSorted24 = FloatArray(24)
  private val tunNormalized24 = FloatArray(24)
  private val tunRawWall = FloatArray(TUN_WALL)
  private val tunSortedWall = FloatArray(TUN_WALL)
  private val tunNormalizedWall = FloatArray(TUN_WALL)
  private var tunCeiling24 = 0f
  private var tunCeilingWall = 0f
  // the opacity everything is drawn with (the tunnel fades in with the song)
  private var ga = 1f
  // the theme color's own saturation and lightness: a lightness written in a drawing is a step away from the theme's (54 is the color itself)
  private var themeS = 100f
  private var themeL = 54f
  private var themeK = 1f

  private fun reset() {
    falling.clear()
    hits.clear()
    dots = null
    stars = null
    radialAngle = 0f
    globeSpin = 0f
    echoes = ArrayList()
    lastBeatNo = Int.MIN_VALUE
    lastBarNo = Int.MIN_VALUE
    waterT = 0f
    ripples = ArrayList()
    mirrorHeights = FloatArray(0)
    tunT = TUN_AHEAD + 2f
    tunNewest = floor((TUN_AHEAD + 2f) / TUN_SPACING).toInt() - 1
    tunSpeed = 0.5f
    tunLoud = 0f
    tunGlow = 0f
    tunGlowShown = 0f
    tunLastBeat = Int.MIN_VALUE
    tunLastBar = Int.MIN_VALUE
    for (h in tunLit) h.fill(0f)
    tunLitGlow.fill(0f)
    tunLockOff = Float.NaN
    tunLockStride = 0
    tunErr = 0f
    tunClock = 0f
    tunLockedAt = -1000f
    tunLastPeriod = 0f
    tunLight.fill(0f)
    tunWall.fill(0f)
    tunCeiling24 = 0f
    tunCeilingWall = 0f
  }

  // the drawing for a preset key. the plain background (none) is not a drawing: bars stand in for it
  fun draw(preset: String, f: VizInput) {
    val key = if (preset == "none" || preset.isEmpty()) "bars" else preset
    if (key != presetKey) {
      presetKey = key
      reset()
    }
    ga = 1f
    if (f.themed) {
      themeS = clamp(f.sat, 0f, 100f)
      themeL = clamp(f.light, 0f, 100f)
      themeK = 0.6f
    } else {
      themeS = 100f
      themeL = 54f
      themeK = 1f
    }
    when (key) {
      "particles" -> particles(f)
      "wave" -> wave(f)
      "radial" -> radial(f)
      "starfield" -> starfield(f)
      "pulseGrid" -> pulseGrid(f)
      "network" -> network(f)
      "mirrorSpectrum" -> mirror(f)
      "minimalPulse" -> minimalPulse(f)
      "runner" -> tunnel(f)
      else -> bars(f)
    }
  }

  // ---- small helpers -------------------------------------------------------------------------------------------------------------
  private fun clamp(x: Float, lo: Float, hi: Float) = if (x < lo) lo else if (x > hi) hi else x
  // how hard a kick is (the page's kickDrive): anything above 0.1 counts, full at about 0.8
  private fun kickDrive(f: VizInput) = clamp((clamp(f.bass, 0f, 1f) - 0.1f) * 1.4f, 0f, 1f)

  private fun hsla(h: Float, s: Float, l: Float, a: Float) = VizColor.hsla(h, themeS, clamp(themeL + (l - 54f) * themeK, 4f, 96f), a * ga)

  private fun softCeiling(x: Float) = if (x <= 0.65f) x else 0.65f + 0.35f * tanh((x - 0.65f) / 0.35f)

  // how many 33 ms pictures this picture is worth
  private fun frames(f: VizInput) = clamp(f.dt / 33f, 0.25f, 3f)

  private fun hash01(n: Int): Float {
    var t = (n * -1640531535 + 0x6D2B79F5)
    t = (t xor (t ushr 15)) * (1 or t)
    t = (t + (t xor (t ushr 7)) * (61 or t)) xor t
    return ((t xor (t ushr 14)).toLong() and 0xFFFFFFFFL).toFloat() / 4294967296f
  }

  // how loud the index-th of count bars is, out of the 96 that come with the frame: the loudest of the 96 under each of them
  private fun amp(index: Int, count: Int, f: VizInput): Float {
    val spec = f.spec
    val n = spec.size
    if (n == 0) return 0f
    val first = min(n - 1, floor(index.toFloat() / count * n).toInt())
    val last = min(n - 1, max(first, ceil((index + 1f) / count * n).toInt() - 1))
    var peak = 0f
    for (i in first..last) if (spec[i] > peak) peak = spec[i]
    return peak
  }

  // the bars of a spectrum drawing with a fall of their own: a bar jumps up at once and comes down at a fixed speed, and the mark above it
  // hangs, then falls on a curve (slow at first, faster and faster)
  private fun fallingBars(key: String, count: Int, f: VizInput): FallingBars {
    var s = falling[key]
    if (s == null || s.v.size != count) {
      s = FallingBars(count)
      falling[key] = s
    }
    val k = frames(f)
    for (i in 0 until count) {
      val raw = if (f.playing) amp(i, count, f) else 0f
      val cur = s.v[i]
      s.v[i] = if (raw >= cur) cur + (raw - cur) * min(1f, 0.92f * k) else max(raw, cur - 0.09f * k)
      if (s.v[i] >= s.peak[i]) {
        s.peak[i] = s.v[i]
        s.hold[i] = 8f
        s.vel[i] = 0f
      } else if (s.hold[i] > 0f) {
        s.hold[i] -= k
      } else {
        s.vel[i] = s.vel[i] * 1.1f.pow(k) + 0.0005f * k
        s.peak[i] = max(s.v[i], s.peak[i] - s.vel[i] * k)
      }
    }
    return s
  }

  // hits in the spectrum itself (soft music with no hard peaks too): see hitDetector in vizRenderers.js. 0 for none, else 0.3 to 1
  private fun hitDetector(key: String, bars: FallingBars, count: Int, f: VizInput): Float {
    var s = hits[key]
    if (s == null || s.prev.size != count) {
      s = Hits(count)
      hits[key] = s
    }
    var flux = 0f
    for (i in 0 until count) {
      val a = bars.v[i]
      val rise = a - s.prev[i]
      if (rise > 0f) flux += rise * (if (i < count * 0.35f) 1f else if (i < count * 0.7f) 0.85f else 0.6f)
      s.prev[i] = a
    }
    if (!f.playing) {
      s.seen = 0
      return 0f
    }
    s.seen += 1
    val dev = flux - s.mean
    s.mean += dev * 0.03f
    s.spread += (dev * dev - s.spread) * 0.03f
    val limit = s.mean + 1.6f * sqrt(s.spread) + 0.3f * s.mean + 0.02f
    if (s.seen > 12 && flux > limit && f.now - s.last > 220f) {
      s.last = f.now
      return clamp(0.3f + (flux - limit) / (s.mean + 0.15f), 0.3f, 1f)
    }
    return 0f
  }

  private fun makeDots(count: Int): Array<Dot> {
    val w = g.width
    val h = g.height
    return Array(count) {
      Dot(
        rnd.nextFloat() * w, rnd.nextFloat() * h,
        (rnd.nextFloat() - 0.5f) * 1.4f, (rnd.nextFloat() - 0.5f) * 1.4f - 0.25f,
        rnd.nextFloat() * 5f + 4f, rnd.nextFloat() * 5f + 4f,
        rnd.nextFloat() * 60f - 30f, 0f, rnd.nextFloat() * 0.8f + 0.5f
      )
    }
  }

  // ---- particles -------------------------------------------------------------------------------------------------------------------
  private fun particles(f: VizInput) {
    val W = g.width
    val H = g.height
    val list = dots ?: makeDots(60).also { dots = it }
    val soft = f.soft
    // the kick drives them: a hit above the threshold speeds them up, makes them glow and knocks them about (see the page)
    val drive = kickDrive(f)
    val react = clamp(soft * 0.8f + drive * 1.1f, 0f, 1.6f)
    val k = frames(f)
    val pulseFactor = if (f.playing) 0.85f + f.volume * 0.7f + react * 1.25f else 1f

    if (f.playing && react > 0.03f) {
      g.rectGradientRadial(0f, 0f, W, H, W / 2f, H, H * 1.1f, floatArrayOf(0f, 1f), intArrayOf(hsla(f.hue, 100f, 50f, react * 0.16f), hsla(f.hue, 100f, 42f, 0f)))
    }
    for (p in list) {
      val volumeRise = if (f.playing) 0.45f + f.volume * 1.2f + react * 2.8f else 0.25f
      p.kx = clamp(p.kx * Math.pow(0.9, k.toDouble()).toFloat() + (rnd.nextFloat() - 0.5f) * drive * 2.5f * k, -8f, 8f)
      p.ky = clamp(p.ky * Math.pow(0.9, k.toDouble()).toFloat() + (rnd.nextFloat() - 0.5f) * drive * 2.5f * k, -8f, 8f)
      p.x += p.vx * k + p.kx * k
      p.y += (p.vy - volumeRise) * k + p.ky * k
      if (p.x < -50f) p.x = W + 50f
      if (p.x > W + 50f) p.x = -50f
      if (p.y < -50f) p.y = H + 50f
      if (p.y > H + 50f) p.y = -50f
      val targetAlpha = if (f.playing) min(1f, p.targetAlpha * (1f + react * 0.9f)) * f.fade else 0f
      val fadeSpeed = if (f.fade > 0.5f) 0.16f else 0.22f
      p.alpha += (targetAlpha - p.alpha) * fadeSpeed
      p.radius += (p.baseRadius * pulseFactor - p.radius) * 0.55f
      if (p.alpha > 0.01f) {
        val hue = f.hue
        g.discGradient(p.x, p.y, p.radius * 0.8f, floatArrayOf(0f, 0.6f, 1f), intArrayOf(hsla(hue, 100f, 54f, p.alpha), hsla(hue, 100f, 50f, p.alpha * 0.65f), hsla(hue, 100f, 45f, 0f)))
      }
    }
    if (f.playing) {
      val glowHeight = H * (0.26f + f.level * 0.05f + react * 0.14f)
      val intensity = min(1f, f.level * 0.25f + react * 0.7f + f.volume * 0.15f)
      g.rectGradientV(0f, H - glowHeight, W, glowHeight, H - glowHeight, H, floatArrayOf(0f, 0.3f, 0.6f, 1f),
        intArrayOf(hsla(f.hue, 100f, 48f, 0f), hsla(f.hue, 100f, 48f, intensity * 0.3f), hsla(f.hue, 100f, 44f, intensity * 0.5f), hsla(f.hue, 100f, 40f, intensity * 0.7f)))
    }
  }

  // ---- bars ------------------------------------------------------------------------------------------------------------------------
  private fun bars(f: VizInput) {
    val W = g.width
    val H = g.height
    val barCount = 72
    val slot = W / barCount
    val barWidth = max(2f, slot * 0.58f)
    val barScale = 1f - f.insetTop / 0.8f
    val b = fallingBars("bars", barCount, f)
    // the background: one glow behind the whole length of the bars, from the bottom edge up to the top of the window. always there (a little when
    // quiet), a bit brighter with the level of the music. one gradient that does not move (the page draws the same)
    run {
      var mean = 0f
      for (i in 0 until barCount) mean += b.v[i]
      mean /= barCount
      val level = if (f.playing) clamp(mean, 0f, 1f) else 0f
      val alpha = clamp(0.06f + 0.08f * level + 0.03f * f.bass, 0f, 0.3f)
      g.rectGradientV(0f, 0f, W, H, H, 0f, floatArrayOf(0f, 0.55f, 1f), intArrayOf(hsla(f.hue, 100f, 52f, alpha), hsla(f.hue, 100f, 48f, alpha * 0.45f), hsla(f.hue, 100f, 45f, 0f)))
    }
    val flat = hsla(f.hue, 100f, 54f, 0.95f)
    val heights = FloatArray(barCount)
    for (i in 0 until barCount) {
      val bassWeight = max(0f, 1f - i / (barCount * 0.14f))
      val boosted = softCeiling(b.v[i] * (1f + f.bass * bassWeight * 0.7f + f.bass * 0.12f))
      val height = if (f.playing) max(3f, boosted * H * 0.8f * barScale) else 3f
      heights[i] = height
      g.rect(i * slot + (slot - barWidth) / 2f, H - height, barWidth, height, flat)
    }
    if (f.playing) {
      val cap = hsla(f.hue, 100f, 68f, 0.95f)
      for (i in 0 until barCount) {
        val capY = H - max(heights[i], softCeiling(b.peak[i]) * H * 0.8f * barScale) - 4f
        g.rect(i * slot + (slot - barWidth) / 2f, capY, barWidth, 2.5f, cap)
      }
    }
  }

  // ---- wave ------------------------------------------------------------------------------------------------------------------------
  private fun wave(f: VizInput) {
    val w = f.wave
    if (w.size < 2) return
    val W = g.width
    val H = g.height
    val boost = if (f.playing) 1f + f.bass * 0.9f else 0.05f
    val midY = H / 2f
    g.beginPath()
    val step = W / (w.size - 1)
    for (i in w.indices) {
      val y = midY + w[i] * midY * 0.8f * boost
      if (i == 0) g.moveTo(0f, y) else g.lineTo(i * step, y)
    }
    g.stroke(11f + f.bass * 9f, hsla(f.hue, 100f, 52f, 0.2f))
    g.stroke(3f, hsla(f.hue, 100f, 60f, 0.95f))
  }

  // a wire planet: longitude lines that turn, latitude lines, one color
  private fun globe(cx: Float, cy: Float, r: Float, hue: Float, spin: Float, alpha: Float, lineWidth: Float) {
    g.beginPath()
    g.oval(cx, cy, r, r)
    for (j in 0 until 6) {
      val rx = abs(cos((j / 6f) * Math.PI.toFloat() + spin)) * r
      g.oval(cx, cy, max(0.5f, rx), r)
    }
    for (l in -2..2) {
      val yy = sin((l / 3f) * (Math.PI.toFloat() / 2f)) * r
      val half = sqrt(max(0f, r * r - yy * yy))
      g.oval(cx, cy + yy, half, half * 0.16f)
    }
    g.stroke(lineWidth, hsla(hue, 100f, 58f, alpha))
  }

  // ---- radial ----------------------------------------------------------------------------------------------------------------------
  private fun radial(f: VizInput) {
    if (!f.playing) return
    val W = g.width
    val H = g.height
    val cx = W / 2f
    val cy = H * f.insetCenter
    val unit = min(W, H)
    val base = unit * 0.2f
    val hue = f.hue
    val k = frames(f)
    val soft = f.soft
    val punch = clamp(f.bass, 0f, 1f)
    val COUNT = 96
    val b = fallingBars("radial", COUNT, f)
    radialAngle += (0.0016f + soft * 0.004f + f.bar * 0.012f) * k
    globeSpin += (0.006f + soft * 0.02f) * k

    val first = 3
    val used = COUNT - first - 14
    val radii = FloatArray(used)
    for (i in 0 until used) {
      val bassWeight = max(0f, 1f - i / (used * 0.12f))
      radii[i] = softCeiling(b.v[first + i] * (1f + punch * bassWeight * 0.9f + punch * 0.2f))
    }
    val join = 10
    val meet = (radii[0] + radii[used - 1]) / 2f
    for (j in 0 until join) {
      val t = j / join.toFloat()
      val w = t * t * (3f - 2f * t)
      radii[j] = meet * (1f - w) + radii[j] * w
      radii[used - 1 - j] = meet * (1f - w) + radii[used - 1 - j] * w
    }
    run {
      val copy = radii.copyOf()
      for (i in 0 until used) radii[i] = copy[(i + used - 1) % used] * 0.2f + copy[i] * 0.6f + copy[(i + 1) % used] * 0.2f
    }

    val total = used * 2
    val shape = FloatArray(total)
    val wave = f.wave
    val swell = 1f + soft * 0.1f + punch * 0.12f
    var sum = 0f
    for (i in 0 until total) {
      val lo = radii[i shr 1]
      val v = if (i and 1 == 1) (lo + radii[((i shr 1) + 1) % used]) / 2f else lo
      val u = i / total.toFloat()
      val tri = if (u < 0.5f) u * 2f else 2f - u * 2f
      val wv = if (wave.size > 1) wave[floor(tri * (wave.size - 1)).toInt()] else 0f
      shape[i] = base * swell * (0.74f + v * 0.98f) + wv * base * 0.16f * (1f + punch * 0.8f)
      sum += shape[i]
    }
    val meanRadius = sum / total

    val beatNo = f.beatCount
    val barNo = f.barCount
    if (lastBeatNo == Int.MIN_VALUE) {
      lastBeatNo = beatNo
      lastBarNo = barNo
    }
    val hit = hitDetector("radialHits", b, COUNT, f)
    if (f.locked) {
      if (barNo != lastBarNo) echoes.add(Echo(0f, 1f, shape.copyOf(), radialAngle, meanRadius))
      else if (beatNo != lastBeatNo) echoes.add(Echo(0f, 0.5f, shape.copyOf(), radialAngle, meanRadius))
      else if (hit > 0.6f) echoes.add(Echo(0f, 0.35f, shape.copyOf(), radialAngle, meanRadius))
    } else if (hit > 0f) {
      echoes.add(Echo(0f, hit, shape.copyOf(), radialAngle, meanRadius))
    }
    lastBeatNo = beatNo
    lastBarNo = barNo
    while (echoes.size > 5) echoes.removeAt(0)
    echoes = ArrayList(echoes.filter { it.life < 1f })

    val px = FloatArray(total)
    val py = FloatArray(total)
    fun trace(radiusAt: (Int) -> Float, scale: Float, turn: Float) {
      for (i in 0 until total) {
        val angle = -Math.PI.toFloat() / 2f + (i / total.toFloat()) * Math.PI.toFloat() * 2f + turn
        val r = radiusAt(i) * scale
        px[i] = cx + cos(angle) * r
        py[i] = cy + sin(angle) * r
      }
      g.beginPath()
      g.moveTo((px[total - 1] + px[0]) / 2f, (py[total - 1] + py[0]) / 2f)
      for (i in 0 until total) {
        val j = (i + 1) % total
        g.quadTo(px[i], py[i], (px[i] + px[j]) / 2f, (py[i] + py[j]) / 2f)
      }
      g.closePath()
    }

    for (e in echoes) {
      e.life += (0.018f + (1f - e.strength) * 0.01f) * k
      val grow = 1f + e.life * (0.35f + e.strength * 0.45f)
      val relax = min(1f, e.life * 0.8f)
      trace({ i -> e.shape[i] * (1f - relax) + e.mean * relax }, grow, e.angle)
      g.stroke(1.4f + e.strength, hsla(hue, 100f, 58f, (1f - e.life) * (0.15f + e.strength * 0.35f)))
    }

    globe(cx, cy, base * (0.4f + soft * 0.05f + punch * 0.03f + f.bar * 0.04f), hue, globeSpin, 0.78f, 1.5f)
    if (wave.size > 1) {
      g.beginPath()
      val pts = 120
      for (i in 0..pts) {
        val u = i / pts.toFloat()
        val tri = if (u < 0.5f) u * 2f else 2f - u * 2f
        val wv = wave[floor(tri * (wave.size - 1)).toInt()]
        val angle = u * Math.PI.toFloat() * 2f - radialAngle * 2f
        val r = base * 0.58f + wv * base * 0.09f
        val x = cx + cos(angle) * r
        val y = cy + sin(angle) * r
        if (i == 0) g.moveTo(x, y) else g.lineTo(x, y)
      }
      g.stroke(1.2f, hsla(hue, 100f, 62f, 0.4f))
    }

    trace({ i -> shape[i] }, 1f, radialAngle)
    g.fill(hsla(hue, 100f, 50f, 0.06f))
    g.stroke(12f, hsla(hue, 100f, 52f, 0.2f))
    g.stroke(3.5f, hsla(hue, 100f, 58f, 0.97f))

    val mark = hsla(hue, 100f, 68f, 0.9f)
    val marks = used / 2
    for (m in 0 until marks) {
      val i = Math.round(m * used / marks.toFloat())
      val pk = softCeiling(b.peak[first + i])
      val r = base * swell * (0.74f + max(radii[i], pk) * 0.98f) + 10f
      val angle = -Math.PI.toFloat() / 2f + (i / used.toFloat()) * Math.PI.toFloat() * 2f + radialAngle
      g.rect(cx + cos(angle) * r - 1.5f, cy + sin(angle) * r - 1.5f, 3f, 3f, mark)
    }
  }

  // ---- starfield -------------------------------------------------------------------------------------------------------------------
  private fun starfield(f: VizInput) {
    val W = g.width
    val H = g.height
    val cx = W / 2f
    val cy = H / 2f
    val reach = (W * 0.5f * W * 0.55f) / STAR_FOCAL
    fun fresh(s: Star, far: Boolean) {
      s.x = (rnd.nextFloat() - 0.5f) * 2f * reach
      s.y = (rnd.nextFloat() - 0.5f) * 2f * reach * (H / W)
      s.z = if (far) W else rnd.nextFloat() * W
    }
    var list = stars
    if (list == null || starsFor != W) {
      list = Array(STAR_COUNT) { Star(0f, 0f, 0f).also { s -> fresh(s, false) } }
      stars = list
      starsFor = W
    }
    val k = frames(f)
    val corner = hypot(cx, cy)
    val drive = kickDrive(f)
    val speed = (if (f.playing) 2f + f.volume * 4f + drive * 22f else 1f) * k
    for (s in list) {
      s.z -= speed
      if (s.z <= 1f) fresh(s, true)
      val scale = STAR_FOCAL / s.z
      val sx = s.x * scale + cx
      val sy = s.y * scale + cy
      if (sx < -20f || sx > W + 20f || sy < -20f || sy > H + 20f) {
        if (s.z < W * 0.9f) fresh(s, true)
        continue
      }
      val near = 1f - s.z / W
      val edge = min(1f, hypot(sx - cx, sy - cy) / corner)
      val size = max(0.5f, (0.5f + near * 1.6f) * (1f + edge * 2.6f) * (1f + drive * 0.5f))
      g.circle(sx, sy, size, hsla(f.hue, 100f, 54f, min(1f, near * 1.5f + 0.05f + drive * 0.2f)))
    }
  }

  // ---- pulse grid ------------------------------------------------------------------------------------------------------------------
  private fun pulseGrid(f: VizInput) {
    val cols = 20
    val rows = 12
    val cellW = g.width / cols
    val cellH = g.height / rows
    val colAmps = FloatArray(cols) { amp(it, cols, f) }
    for (row in 0 until rows) {
      for (col in 0 until cols) {
        val bassWeight = max(0f, 1f - col / (cols * 0.15f))
        val raw = min(1f, colAmps[col] * (1f + f.bass * bassWeight * 0.8f))
        val rowFalloff = 1f - abs(row - rows / 2f) / (rows / 2f)
        val intensity = if (f.playing) raw * rowFalloff else rowFalloff * 0.05f
        if (intensity < 0.03f) continue
        val pad = 2f
        g.rect(col * cellW + pad, row * cellH + pad, cellW - pad * 2f, cellH - pad * 2f, hsla(f.hue, 100f, 54f, intensity * 0.9f))
      }
    }
  }

  // ---- network ---------------------------------------------------------------------------------------------------------------------
  private fun network(f: VizInput) {
    val W = g.width
    val H = g.height
    val nodes = dots ?: makeDots(80).also { dots = it }
    val soft = f.soft
    // the kick drives the web like the particles: a hit makes it swell and the nodes jump
    val drive = kickDrive(f)
    val react = clamp(soft * 0.8f + drive * 1.1f, 0f, 1.6f)
    val k = frames(f)
    val pulseFactor = if (f.playing) 0.75f + react * 1.1f else 0.5f
    val speedMul = if (f.playing) 1.3f + react * 3f + f.volume * 1.8f else 0.8f
    for (n in nodes) {
      n.kx = clamp(n.kx * Math.pow(0.9, k.toDouble()).toFloat() + (rnd.nextFloat() - 0.5f) * drive * 2.5f * k, -8f, 8f)
      n.ky = clamp(n.ky * Math.pow(0.9, k.toDouble()).toFloat() + (rnd.nextFloat() - 0.5f) * drive * 2.5f * k, -8f, 8f)
      n.x += n.vx * speedMul * k + n.kx * k
      n.y += n.vy * speedMul * k + n.ky * k
      if (n.x < 0f) n.x = W
      if (n.x > W) n.x = 0f
      if (n.y < 0f) n.y = H
      if (n.y > H) n.y = 0f
    }
    val maxDist = 120f + react * 70f
    val limit2 = maxDist * maxDist
    val lineWidth = 1f + react * 0.8f
    for (i in nodes.indices) {
      for (j in i + 1 until nodes.size) {
        val a = nodes[i]
        val b = nodes[j]
        val dx = a.x - b.x
        val dy = a.y - b.y
        val d2 = dx * dx + dy * dy
        if (d2 < limit2) {
          val alpha = min(0.85f, (1f - sqrt(d2) / maxDist) * 0.9f * pulseFactor)
          g.line(a.x, a.y, b.x, b.y, lineWidth, hsla(f.hue, 100f, 54f, alpha))
        }
      }
    }
    val dot = hsla(f.hue, 100f, 64f, 0.92f)
    for (n in nodes) g.circle(n.x, n.y, 1.8f * pulseFactor + 1f + react * 1.2f, dot)
  }

  // ---- mirror spectrum (the water) -------------------------------------------------------------------------------------------------
  private fun mirror(f: VizInput) {
    val W = g.width
    val H = g.height
    val midY = Math.round(H * 0.5f).toFloat()
    val hue = f.hue
    val barCount = 80
    val slot = W / barCount
    val barW = max(2f, slot * 0.58f)
    val k = frames(f)
    val soft = f.soft
    waterT += (f.dt / 1000f) * (1f + soft * 0.9f)
    val t = waterT
    val b = fallingBars("mirror", barCount, f)
    val skyH = H * (0.36f - f.insetTop * 0.6f)

    if (mirrorHeights.size != barCount) mirrorHeights = FloatArray(barCount)
    val heights = mirrorHeights
    var maxH = 2f
    for (i in 0 until barCount) {
      val bassWeight = max(0f, 1f - i / (barCount * 0.14f))
      val boosted = softCeiling(b.v[i] * (1f + f.bass * bassWeight * 0.7f + f.bass * 0.12f))
      heights[i] = if (f.playing) max(2f, boosted * skyH) else 2f
      if (heights[i] > maxH) maxH = heights[i]
    }

    g.rectGradientV(0f, midY, W, H - midY, midY, H, floatArrayOf(0f, 0.5f, 1f),
      intArrayOf(hsla(hue, 100f, 30f, 0.38f), hsla(hue, 100f, 22f, 0.16f), hsla(hue, 100f, 18f, 0f)))

    val flat = hsla(hue, 100f, 54f, 0.95f)
    for (i in 0 until barCount) g.rect(i * slot + (slot - barW) / 2f, midY - heights[i], barW, heights[i], flat)
    if (f.playing) {
      val cap = hsla(hue, 100f, 80f, 0.95f)
      for (i in 0 until barCount) {
        val peak = max(heights[i], softCeiling(b.peak[i]) * skyH)
        g.rect(i * slot + (slot - barW) / 2f, midY - peak - 4f, barW, 2.5f, cap)
      }
    }

    // the reflection: the same bars, cut into thin slices that are pushed sideways by waves (the further down, the more) and fade with depth
    val slice = 3f
    val depth = maxH + slice * 2f
    val surge = 1f + soft * 0.9f
    var d = 0f
    while (d < depth) {
      val dx = (1.2f + d * 0.045f) * (sin(d * 0.07f + t * 2f) + 0.6f * sin(d * 0.19f - t * 2.9f)) * surge
      val fade = (1f - d / depth).pow(1.3f)
      val alpha = clamp(0.85f * fade * (0.9f + 0.1f * sin(d * 0.05f + t * 3f)), 0f, 1f)
      if (alpha > 0.01f) {
        // all the bars that reach this deep are one path, so a slice is one draw and not eighty
        g.beginPath()
        var any = false
        for (i in 0 until barCount) {
          if (heights[i] > d) {
            val x = i * slot + (slot - barW) / 2f + dx
            g.moveTo(x, midY + d)
            g.lineTo(x + barW, midY + d)
            g.lineTo(x + barW, midY + d + slice)
            g.lineTo(x, midY + d + slice)
            g.closePath()
            any = true
          }
        }
        if (any) g.fill(hsla(hue, 100f, 54f, alpha))
      }
      d += slice
    }

    // the surface: a bright line and a short glow under it
    g.rectGradientV(0f, midY, W, 22f, midY, midY + 22f, floatArrayOf(0f, 1f), intArrayOf(hsla(hue, 100f, 62f, 0.34f), hsla(hue, 100f, 62f, 0f)))
    g.rect(0f, midY - 1f, W, 2.5f, hsla(hue, 100f, 70f, 0.9f))

    // rings from the surface: on every beat (a bigger one on a bar) with a tempo, else when the sound itself hits
    val beatNo = f.beatCount
    val barNo = f.barCount
    if (lastBeatNo == Int.MIN_VALUE) {
      lastBeatNo = beatNo
      lastBarNo = barNo
    }
    if (f.playing && f.locked) {
      if (barNo != lastBarNo) ripples.add(Ripple(0f, 1f, W * (0.3f + 0.4f * hash01(barNo))))
      else if (beatNo != lastBeatNo) ripples.add(Ripple(0f, 0.4f, W * (0.15f + 0.7f * hash01(beatNo + 500))))
    } else {
      val hit = hitDetector("mirrorHits", b, barCount, f)
      if (hit > 0f) ripples.add(Ripple(0f, hit, W / 2f))
    }
    lastBeatNo = beatNo
    lastBarNo = barNo
    while (ripples.size > 7) ripples.removeAt(0)
    ripples = ArrayList(ripples.filter { it.life < 1f })
    if (ripples.isNotEmpty()) {
      g.save()
      g.clipRect(0f, midY, W, H - midY)
      for (r in ripples) {
        r.life += (0.012f + r.strength * 0.014f) * k
        val radius = r.life * W * (0.22f + r.strength * 0.3f)
        val alpha = (1f - r.life) * (0.4f + r.strength * 0.5f)
        g.beginPath()
        g.oval(r.x, midY + 2f, radius, radius * 0.13f)
        g.stroke(2f + r.strength * 1.5f, hsla(hue, 100f, 70f, alpha))
      }
      g.restore()
    }
  }

  // ---- minimal pulse ---------------------------------------------------------------------------------------------------------------
  private fun minimalPulse(f: VizInput) {
    val cx = g.width / 2f
    val cy = g.height / 2f
    val baseRadius = min(g.width, g.height) * 0.08f
    val pulse = if (f.playing) baseRadius * (1f + f.bass * 1.8f) else baseRadius
    g.discGradient(cx, cy, pulse * 2f, floatArrayOf(0f, 1f), intArrayOf(hsla(f.hue, 100f, 54f, 0.6f), hsla(f.hue, 100f, 54f, 0f)))
    g.beginPath()
    g.oval(cx, cy, pulse, pulse)
    g.stroke(2.5f, hsla(f.hue, 100f, 60f, 0.95f))
  }

  // ---- the corridor (the preset called runner) -------------------------------------------------------------------------------------
  // a ten sided tube of wire that drifts slowly away, lit by the walls: soft radial patches with a lot of blur along the walls (bass at the
  // bottom, highs on top). the lines get thinner and blurrier with distance and there are fewer of them (every second ring is kept beyond a
  // few rings, every fourth further out). with a tempo a ring is born on every beat and the rings are held on the beat clock. the same
  // drawing as the page (vizRenderers.js renderRunner)
  // the range of this song (the same as the page): a quiet floor and a loud ceiling, kept in range (two numbers, NaN until the first picture)
  private fun normalizeCorridorLevels(levels: FloatArray, sorted: FloatArray, output: FloatArray, range: FloatArray, dt: Float) {
    if (levels.isEmpty()) return
    System.arraycopy(levels, 0, sorted, 0, levels.size)
    java.util.Arrays.sort(sorted)
    val n = sorted.size
    val quiet = sorted[((n - 1) * 0.2f).toInt()]
    val loud = sorted[((n - 1) * 0.9f).toInt()]
    if (range[0].isNaN()) { range[0] = quiet; range[1] = max(loud, quiet + 0.1f) }
    range[0] += (quiet - range[0]) * (1f - exp(-2f * dt))
    val hiTarget = max(loud, range[0] + 0.1f)
    val rate = if (hiTarget > range[1]) 10f else 0.6f
    range[1] += (hiTarget - range[1]) * (1f - exp(-rate * dt))
    val span = max(0.14f, range[1] - range[0])
    for (i in levels.indices) output[i] = 0.12f + 0.88f * clamp((levels[i] - range[0]) / span, 0f, 1f)
  }

  private fun tunnelKeep(k: Int, z: Float): Float {
    if (z < 3f) return 1f
    var a = 1f
    if ((k and 1) != 0) a *= 1f - clamp((z - 3f) / 2f, 0f, 1f)
    else if ((k and 2) != 0) a *= 1f - clamp((z - 6f) / 2f, 0f, 1f)
    return a
  }

  private fun tunnel(f: VizInput) {
    val W = g.width
    val H = g.height
    val hue = f.hue
    val dt = clamp(f.dt / 1000f, 0.004f, 0.1f)
    val playing = f.playing
    val soft = f.soft
    val period = f.period / 1000f
    val locked = f.locked && period > 0.25f && period < 1.6f && playing
    val unit = min(W, H)
    val sc = clamp(unit / 600f, 0.8f, 2f)

    // the pace: the tempo sets the speed and the beat clock only nudges it (a few percent, smoothed), so it never stops. see the page's drawing
    tunLoud += ((if (playing) clamp(f.volume, 0f, 1f) else 0f) - tunLoud) * min(1f, dt * 0.7f)
    tunClock += dt
    if (locked) {
      tunLockedAt = tunClock
      tunLastPeriod = period
    }
    val holding = !locked && playing && tunLastPeriod > 0f && tunClock - tunLockedAt < 3f && tunLockStride > 0
    if (locked || holding) {
      val per = if (locked) period else tunLastPeriod
      var stride = tunLockStride
      if (stride == 0) {
        stride = 1
        while (TUN_SPACING / (stride * per) > 1.1f && stride < 4) stride += 1
      } else if (TUN_SPACING / (stride * per) > 1.3f && stride < 4) stride += 1
      else if (stride > 1 && TUN_SPACING / ((stride - 1) * per) < 0.95f) stride -= 1
      val base = clamp(TUN_SPACING / (stride * per), 0.22f, 1.4f)
      var nudge = 0f
      if (locked) {
        val beats = f.beatCount + clamp(f.phase, 0f, 0.999f)
        val target = (beats / stride) * TUN_SPACING
        if (tunLockOff.isNaN() || tunLockStride != stride) {
          tunLockOff = Math.round((tunT - target) / TUN_SPACING) * TUN_SPACING
          tunLockStride = stride
          tunErr = 0f
        }
        var err = target + tunLockOff - tunT
        err -= Math.round(err / TUN_SPACING) * TUN_SPACING
        tunErr += (err - tunErr) * min(1f, dt * 1.2f)
        nudge = clamp(tunErr / (TUN_SPACING * 0.5f), -1f, 1f) * 0.18f
      } else {
        tunLockStride = stride
      }
      tunSpeed += (base * (1f + nudge) - tunSpeed) * min(1f, dt * 2.5f)
      tunT += max(0.2f, tunSpeed) * dt
    } else {
      tunLockOff = Float.NaN
      tunLockStride = 0
      tunErr = 0f
      val wantSpeed = if (playing) 0.45f + tunLoud * 0.6f else 0.25f
      tunSpeed += (wantSpeed - tunSpeed) * min(1f, dt * 0.9f)
      tunT += max(0.2f, tunSpeed) * dt
    }

    val b = fallingBars("tunnel", 24, f)
    for (i in tunRaw24.indices) tunRaw24[i] = b.v[i]
    normalizeCorridorLevels(tunRaw24, tunSorted24, tunNormalized24, lohi24, dt)
    fun band(a: Int, c: Int): Float {
      var m = 0f
      for (i in a until c) if (tunNormalized24[i] > m) m = tunNormalized24[i]
      return m
    }
    // eight bands from the bass up, they go round the tube once
    val bandFrom = intArrayOf(0, 1, 3, 5, 8, 11, 15, 19)
    val bandTo = intArrayOf(2, 4, 6, 9, 12, 16, 20, 24)
    val cur = FloatArray(TUN_BANDS) { i -> if (playing) band(bandFrom[i], bandTo[i]) else 0f }

    val beatNo = f.beatCount
    val barNo = f.barCount
    if (tunLastBeat == Int.MIN_VALUE) {
      tunLastBeat = beatNo
      tunLastBar = barNo
    }
    val hit = hitDetector("tunnelHits", b, 24, f)
    var strength = 0f
    if (locked) {
      if (barNo != tunLastBar) strength = 1f else if (beatNo != tunLastBeat) strength = 0.6f
    } else if (hit > 0f) strength = 0.3f + hit * 0.5f
    tunLastBeat = beatNo
    tunLastBar = barNo
    if (strength > 0f) tunGlow = max(tunGlow, strength)
    tunGlow = max(0f, tunGlow - dt * 1.6f)
    tunGlowShown += (tunGlow - tunGlowShown) * min(1f, dt * 10f)
    for (i in 0 until TUN_BANDS) tunLight[i] += (cur[i] - tunLight[i]) * min(1f, dt * (if (cur[i] > tunLight[i]) 14f else 3f))
    // the bars of the wall: 96 of them, their own reading of the sound
    val wallBars = fallingBars("wall", TUN_WALL, f)
    for (i in tunRawWall.indices) tunRawWall[i] = wallBars.v[i]
    normalizeCorridorLevels(tunRawWall, tunSortedWall, tunNormalizedWall, lohiWall, dt)
    for (i in 0 until TUN_WALL) {
      val want = if (playing) tunNormalizedWall[i] else 0f
      tunWall[i] += (want - tunWall[i]) * min(1f, dt * (if (want > tunWall[i]) 14f else 3f))
    }

    // the rings born since the last picture (a ring is a plain ring, it carries nothing of the sound)
    val newest = floor(tunT / TUN_SPACING).toInt()
    if (tunNewest < newest) tunNewest = newest

    ga = 0.3f + 0.7f * f.fade
    val CX = W / 2f
    val CY = H * 0.5f
    // the rings are circles (polygons of ten sides), the same in a wide window as in a tall one. the strips of the bars radiate from the middle in a bigger
    // circle, big enough to reach the corners of the window
    val FR = unit * 0.5f
    val FS = hypot(W, H) * 0.5f
    fun fogAt(z: Float) = clamp(1f - (z - TUN_NEAR) / TUN_AHEAD, 0f, 1f).pow(1.6f)
    val bloom = tunGlowShown
    // the general intensity of the music, 0 to 1: everything lights up with it at once. one color, only the opacity moves
    var mean = 0f
    for (i in 0 until TUN_WALL) mean += tunWall[i]
    mean /= TUN_WALL
    val inten = clamp(mean * 1.4f + bloom * 0.5f + soft * 0.3f, 0f, 1f)
    val colorL = 54f

    // the wall of light: 96 bars packed side by side round the circle (the bass at the bottom, clockwise), each as long as it is loud and fading out toward the middle (no tip,
    // nothing at the end of a bar that rises and falls). they are drawn small and sharp on a layer of their own, which is halved repeatedly and stretched up to the window: that
    // blurs them into one solid force, the way the background of the bars visualizer is soft. drawn before the rings so the rings are in front
    val half = (Math.PI.toFloat() * 2f / TUN_WALL) * 0.62f
    val cuts = 6
    g.blurLayer(8f) { l ->
      for (i in 0 until TUN_WALL) {
        val level = tunWall[i]
        val angle = ((i + 0.5f) / TUN_WALL) * Math.PI.toFloat() * 2f
        val rOut = 1.15f
        val rIn = 0.52f - 1.3f * level
        val strength = clamp((0.2f + 1.0f * level) * (0.85f + 0.5f * inten), 0f, 1f)
        for (c in 0 until cuts) {
          val r0 = rOut + (rIn - rOut) * (c / cuts.toFloat())
          val r1 = rOut + (rIn - rOut) * ((c + 1) / cuts.toFloat())
          val alpha = strength * 0.25f * (1f - (c + 0.5f) / cuts)
          if (alpha < 0.01f) continue
          l.beginPath()
          l.moveTo(CX + sin(angle - half) * FS * r0, CY + cos(angle - half) * FS * r0)
          l.lineTo(CX + sin(angle + half) * FS * r0, CY + cos(angle + half) * FS * r0)
          l.lineTo(CX + sin(angle + half) * FS * r1, CY + cos(angle + half) * FS * r1)
          l.lineTo(CX + sin(angle - half) * FS * r1, CY + cos(angle - half) * FS * r1)
          l.closePath()
          l.fill(hsla(hue, 100f, colorL, alpha))
        }
      }
    }

    // the rings, from far to near: thin and faint far away (the fog), only some of them far out, a soft glow only on the near ones
    val ringAlpha = 0.5f + 0.4f * inten
    for (j in TUN_FARTHEST downTo 1) {
      val k = tunNewest - j + 1
      val z = TUN_NEAR + (tunT - k * TUN_SPACING)
      if (z - TUN_NEAR > TUN_AHEAD) continue
      val fog = fogAt(z)
      if (fog < 0.004f) continue
      val keep = tunnelKeep(k, z)
      if (keep < 0.01f) continue
      val depth = clamp((z - TUN_NEAR) / TUN_AHEAD, 0f, 1f)
      val w = clamp(3.2f / (1f + z * 0.7f), 0.35f, 3.2f) * sc
      val halo = 3.2f * sc * clamp(1f - depth / 0.4f, 0f, 1f)
      val alpha = ringAlpha * fog * keep * (1f - 0.6f * depth)
      for (pass in 0 until 2) {
        if (pass == 0 && halo <= 0.2f) continue
        g.beginPath()
        for (v in 0 until TUN_SIDES) {
          val a = (v / TUN_SIDES.toFloat()) * Math.PI.toFloat() * 2f
          val x = CX + sin(a) * FR / z
          val y = CY + cos(a) * FR / z
          if (v == 0) g.moveTo(x, y) else g.lineTo(x, y)
        }
        g.closePath()
        if (pass == 0) g.stroke(w + halo, hsla(hue, 100f, colorL, alpha * 0.14f * clamp(1f - depth / 0.4f, 0f, 1f)))
        else g.stroke(w, hsla(hue, 100f, colorL, alpha))
      }
    }
    // the fog at the far end, on top of everything: dark, so the rings that have already passed vanish into it
    val fogR = unit * 0.26f
    // the middle is always the same dark (solid to 0.4 of the radius), so the light of the walls does not show through it on the beat
    g.rectGradientRadial(CX - fogR, CY - fogR, fogR * 2f, fogR * 2f, CX, CY, fogR, floatArrayOf(0f, 0.4f, 0.6f, 1f), intArrayOf(0xFF000000.toInt(), 0xFF000000.toInt(), 0x73000000, 0x00000000))
    ga = 1f
  }

  companion object {
    const val STAR_COUNT = 460
    const val STAR_FOCAL = 150f
    const val TUN_SIDES = 10
    const val TUN_AHEAD = 11f
    const val TUN_SPACING = 0.45f
    const val TUN_NEAR = 0.3f
    const val TUN_FARTHEST = 27
    const val TUN_RINGS = TUN_FARTHEST + 4
    const val TUN_BANDS = 8
    // the bars that shape the light of the walls, and the points the edge of the wall is drawn through
    const val TUN_WALL = 72
    const val TUN_WALL_POINTS = 72

    val PRESETS = listOf("bars", "mirrorSpectrum", "radial", "particles", "network", "runner", "wave", "starfield", "pulseGrid", "minimalPulse")

    // what a preset leaves free at the top or in the middle for the song information (the same numbers as the page's songInfo.js, but for a
    // tall screen: the page asks for the layout of the phone)
    fun insetTop(preset: String): Float = when (preset) {
      "bars" -> 0.24f
      "mirrorSpectrum" -> 0.12f
      else -> 0f
    }

    fun insetCenter(preset: String): Float = if (preset == "radial") 0.38f else 0.5f
  }
}
