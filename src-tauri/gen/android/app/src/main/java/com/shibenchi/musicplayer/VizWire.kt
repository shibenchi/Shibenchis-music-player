package com.shibenchi.musicplayer

// one frame of the page's audio analysis, as the page sends it to the phone's windows (the floating mini player and the live wallpaper). it
// is one line of text: "hue,bass,preset,soft,beat,bar,bpm,locked,phase,period,beats,bars,beatInBar,volume,saturation,lightness;b0,...,b95;w0,...,w95"
// (see buildPhoneText in App.js): the theme hue, how hard the last hit was, the drawing that is picked, the numbers of the tempo follower,
// then 96 spectrum bars and 96 points of the waveform, both 0 to 255 (128 is the middle of the wave). an older page sent
// "hue,bass,wave;24 bars;96 points", that still parses (wave is a flag there: 1 for the wave drawing, 0 for bars)
class VizFrame(
  val hue: Float,
  val bass: Float,
  val preset: String,
  val soft: Float,
  val beat: Float,
  val bar: Float,
  val bpm: Float,
  val locked: Boolean,
  val phase: Float,
  val period: Float,
  val beatCount: Int,
  val barCount: Int,
  val beatInBar: Int,
  val volume: Float,
  // the theme color's saturation and lightness (0 to 100), or -1 when the page did not send them
  val sat: Float,
  val light: Float,
  val spec: FloatArray,
  val wave: FloatArray,
  val at: Long
) {
  // into the form the drawings take
  fun fill(into: VizInput) {
    into.hue = hue
    into.playing = true
    into.bass = bass
    into.soft = soft
    into.beat = beat
    into.bar = bar
    into.bpm = bpm
    into.locked = locked
    into.phase = phase
    into.period = period
    into.beatCount = beatCount
    into.barCount = barCount
    into.beatInBar = beatInBar
    into.volume = volume
    into.themed = sat >= 0f && light >= 0f
    if (into.themed) {
      into.sat = sat
      into.light = light
    }
    into.spec = spec
    into.wave = wave
    // the loudness of the low end (the page has a number for it, the frame does not carry it)
    var low = 0f
    val n = minOf(8, spec.size)
    for (i in 0 until n) low += spec[i]
    into.level = if (n > 0) low / n else 0f
  }

  companion object {
    fun parse(text: String, at: Long): VizFrame? {
      val parts = text.split(';')
      if (parts.size < 3) return null
      val head = parts[0].split(',')
      fun num(i: Int) = head.getOrNull(i)?.trim()?.toFloatOrNull() ?: 0f
      val third = head.getOrNull(2)?.trim() ?: ""
      val preset = when (third) {
        "1" -> "wave"
        "0", "" -> "bars"
        else -> third
      }
      val spec = parts[1].split(',').map { (it.trim().toIntOrNull() ?: 0) / 255f }.toFloatArray()
      val wave = parts[2].split(',').map { ((it.trim().toIntOrNull() ?: 128) - 128) / 128f }.toFloatArray()
      // the two last numbers of the line are new: a page that does not send them leaves the drawings as they were
      val sat = head.getOrNull(14)?.trim()?.toFloatOrNull() ?: -1f
      val light = head.getOrNull(15)?.trim()?.toFloatOrNull() ?: -1f
      return VizFrame(
        num(0), num(1), preset, num(3), num(4), num(5), num(6), num(7) == 1f, num(8), num(9),
        num(10).toInt(), num(11).toInt(), num(12).toInt(), num(13), sat, light, spec, wave, at
      )
    }
  }
}
