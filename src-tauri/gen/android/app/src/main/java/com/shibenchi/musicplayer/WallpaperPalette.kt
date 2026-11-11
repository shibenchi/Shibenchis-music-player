package com.shibenchi.musicplayer

import android.graphics.Color

// the three colors the live wallpaper tells the system it is made of (see SmpWallpaperService.onComputeColors).
//
// the phone takes its color palette from the wallpaper when the person has picked the wallpaper colors in the system settings (Wallpaper
// and style, Color palette), and the icons that follow that palette change with it. what the system should see is the color the app is
// in: the theme color the person picked in the app, as it is, and the two colors next to it on the color wheel. nothing here changes a
// system setting, it only answers when the system asks which colors the wallpaper has
object WallpaperPalette {
  // what the colors are made from. when it is different from the last time, the colors changed
  fun key(): String = NowPlaying.accent.toString()

  fun colors(): IntArray {
    val accent = NowPlaying.accent or 0xFF000000.toInt()
    val hsv = FloatArray(3)
    Color.colorToHSV(accent, hsv)
    return intArrayOf(accent, neighbour(hsv, 30f), neighbour(hsv, -30f))
  }

  private fun neighbour(hsv: FloatArray, turn: Float): Int =
    Color.HSVToColor(floatArrayOf(((hsv[0] + turn) % 360f + 360f) % 360f, hsv[1].coerceAtLeast(0.55f), hsv[2].coerceAtLeast(0.7f)))
}
