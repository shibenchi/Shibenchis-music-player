package com.shibenchi.musicplayer

import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

// the song on the live wallpaper of the phone: the title, the artist and how far into the song it is, in a different place for each drawing
// (src/songInfo.js does the same on the computer). the drawings leave room for it (VizPainter.insetTop and insetCenter). nothing is drawn
// below 84% of the height, where the dock and the navigation bar are, and the sides keep 8% free
class VizSong(val title: String, val artist: String, val elapsed: Float, val duration: Float)

object VizInfo {
  // text (x, y as shares of the width and height of the screen, align 0 left 1 center 2 right), the progress (bar: x, y, width; surface: the
  // water line; arc: a line round the ring of the radial drawing)
  class Place(val tx: Float, val ty: Float, val align: Int, val plate: Boolean, val kind: Int, val bx: Float, val by: Float, val bw: Float, val radius: Float)

  private const val BAR = 0
  private const val SURFACE = 1
  private const val ARC = 2
  private const val SIDE = 0.08f

  private fun bar(tx: Float, ty: Float, align: Int, bx: Float, by: Float, bw: Float, plate: Boolean = false) = Place(tx, ty, align, plate, BAR, bx, by, bw, 0f)

  fun place(preset: String): Place = when (preset) {
    "bars" -> bar(SIDE, 0.075f, 0, SIDE, 0.175f, 1f - SIDE * 2f)
    "mirrorSpectrum" -> Place(SIDE, 0.07f, 0, false, SURFACE, 0f, 0.5f, 1f, 0f)
    "radial" -> Place(0.5f, 0.66f, 1, false, ARC, 0f, 0f, 0f, 0.43f)
    "network" -> bar(1f - SIDE, 0.075f, 2, 0.5f, 0.17f, 1f - SIDE - 0.5f)
    "starfield" -> bar(0.5f, 0.075f, 1, 0.12f, 0.82f, 0.76f)
    "pulseGrid" -> bar(0.5f, 0.70f, 1, 0.2f, 0.795f, 0.6f, true)
    "wave" -> bar(SIDE, 0.66f, 0, SIDE, 0.78f, 1f - SIDE * 2f)
    "minimalPulse" -> bar(0.5f, 0.62f, 1, 0.25f, 0.72f, 0.5f)
    "runner" -> bar(0.5f, 0.70f, 1, 0.2f, 0.8f, 0.6f)
    else -> bar(SIDE, 0.68f, 0, SIDE, 0.79f, 1f - SIDE * 2f)
  }

  private fun clock(seconds: Float): String {
    val s = max(0, seconds.toInt())
    return "${s / 60}:${(s % 60).toString().padStart(2, '0')}"
  }

  private fun fit(g: Gfx, text: String, maxWidth: Float, size: Float, bold: Boolean): String {
    if (g.textWidth(text, size, bold) <= maxWidth) return text
    var lo = 0
    var hi = text.length
    while (lo < hi) {
      val mid = (lo + hi + 1) / 2
      if (g.textWidth(text.substring(0, mid) + "...", size, bold) <= maxWidth) lo = mid else hi = mid - 1
    }
    return text.substring(0, lo) + "..."
  }

  fun draw(g: Gfx, preset: String, song: VizSong, hue: Float, alpha: Float, centerShare: Float) {
    if (song.title.isEmpty()) return
    val W = g.width
    val H = g.height
    val unit = min(W, H)
    val p = place(preset)
    val titleSize = (unit * 0.05f).coerceIn(14f, 40f)
    val artistSize = titleSize * 0.7f
    val small = titleSize * 0.52f
    val share = if (song.duration > 0f) (song.elapsed / song.duration).coerceIn(0f, 1f) else 0f
    val a = alpha.coerceIn(0f, 1f)
    fun color(l: Float, s: Float, al: Float) = VizColor.hsla(hue, s, l, al * a)

    val x = W * p.tx
    val y = H * p.ty + titleSize
    val maxWidth = when (p.align) {
      1 -> W * (1f - SIDE * 2f)
      2 -> W * p.tx - W * SIDE
      else -> W * (1f - SIDE) - W * p.tx
    }
    val title = fit(g, song.title, maxWidth, titleSize, true)
    val artist = if (song.artist.isNotEmpty()) fit(g, song.artist, maxWidth, artistSize, false) else ""
    if (p.plate) {
      val wide = max(g.textWidth(title, titleSize, true), if (artist.isEmpty()) 0f else g.textWidth(artist, artistSize, false)) + titleSize * 1.6f
      g.rect(x - wide / 2f, y - titleSize * 1.15f, wide, titleSize * (if (artist.isEmpty()) 1.6f else 2.5f), 0x9E04060A.toInt())
    }
    g.text(title, x, y, titleSize, true, p.align, color(96f, 35f, 0.97f))
    if (artist.isNotEmpty()) g.text(artist, x, y + artistSize * 1.35f, artistSize, false, p.align, color(70f, 90f, 0.92f))

    val track = color(50f, 100f, 0.28f)
    val fill = color(60f, 100f, 0.97f)
    val label = color(80f, 60f, 0.85f)
    if (p.kind == ARC) {
      val cx = W / 2f
      val cy = H * centerShare
      val r = unit * p.radius
      val width = max(2f, unit * 0.005f)
      g.beginPath()
      g.oval(cx, cy, r, r)
      g.stroke(width, track)
      if (share > 0f) {
        // from the top, clockwise: short straight pieces along the arc
        g.beginPath()
        val steps = max(2, (share * 120f).toInt())
        for (i in 0..steps) {
          val ang = -Math.PI.toFloat() / 2f + (share * i / steps) * Math.PI.toFloat() * 2f
          val px = cx + cos(ang) * r
          val py = cy + sin(ang) * r
          if (i == 0) g.moveTo(px, py) else g.lineTo(px, py)
        }
        g.stroke(width, fill)
      }
      val ang = -Math.PI.toFloat() / 2f + share * Math.PI.toFloat() * 2f
      g.circle(cx + cos(ang) * r, cy + sin(ang) * r, width * 1.6f, fill)
      g.text("${clock(song.elapsed)} / ${clock(song.duration)}", W / 2f, y + artistSize * 1.35f + small * 1.7f, small, false, 1, label)
    } else if (p.kind == SURFACE) {
      // the water line already is a bright line across the screen, so the progress is a white strip on it, thicker than the line, from the left
      // edge (the start) to the right edge (the end): a pale track, the played part solid and a small upright mark where it has got to
      val by = H * 0.5f
      val th = max(5f, unit * 0.0075f)
      g.rect(0f, by - th / 2f, W, th, color(100f, 0f, 0.3f))
      g.rect(0f, by - th / 2f, W * share, th, color(100f, 0f, 0.98f))
      g.rect(min(W - th * 0.45f, max(0f, W * share - th * 0.45f)), by - th * 2.1f, th * 0.9f, th * 4.2f, color(100f, 0f, 0.98f))
    } else {
      val bx = W * p.bx
      val by = H * p.by
      val bw = W * p.bw
      val th = max(3f, unit * 0.005f)
      g.rect(bx, by - th / 2f, bw, th, track)
      g.rect(bx, by - th / 2f, bw * share, th, fill)
      g.circle(bx + bw * share, by, th * 1.5f, fill)
      val labelY = by + th * 2f + small * 1.1f
      g.text(clock(song.elapsed), bx, labelY, small, false, 0, label)
      g.text(clock(song.duration), bx + bw, labelY, small, false, 2, label)
    }
  }
}
