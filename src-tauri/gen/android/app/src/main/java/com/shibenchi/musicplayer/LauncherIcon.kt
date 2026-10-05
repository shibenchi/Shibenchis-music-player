package com.shibenchi.musicplayer

import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import android.util.Log

// the launcher icon of the app (the one in the app drawer) is one of twelve colored entries of
// the manifest, exactly one enabled. changing the color means switching which one is on, and
// android closes the screen that was opened from the entry that gets switched off. that is the
// app vanishing in the middle of the settings, so the switch waits until the app is not on
// screen and nothing is playing (the page that plays lives in that screen)
object LauncherIcon {
  private const val TAG = "SmpIcon"
  private const val PREFS = "smp_icon"
  private val main = Handler(Looper.getMainLooper())

  // the app screen is showing (set by MainActivity)
  @Volatile var appVisible = false

  // the color the person picked now. applied right away only when that is safe
  fun request(context: Context, preset: Int) {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    // the manifest starts with the first entry on, nothing to switch for it
    val current = prefs.getInt("preset", 0)
    if (preset == current) {
      prefs.edit().remove("wanted").apply()
      return
    }
    prefs.edit().putInt("wanted", preset).apply()
    if (!appVisible) applyPending(context)
  }

  // after the app has been left for a few seconds (called from MainActivity.onStop)
  fun applyLater(context: Context) {
    val app = context.applicationContext
    main.postDelayed({ applyPending(app) }, 4000)
  }

  // switches to the wanted color if there is one and it is safe: not on screen, nothing playing
  fun applyPending(context: Context) {
    try {
      if (appVisible || NowPlaying.playing || NowPlaying.inRoom) return
      val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      val wanted = prefs.getInt("wanted", -1)
      if (wanted < 0 || wanted == prefs.getInt("preset", 0)) return
      val manager = context.packageManager
      fun entry(index: Int) = ComponentName(context, "com.shibenchi.musicplayer.Icon%02d".format(index))
      // the new one first, so there is never a moment with none enabled
      manager.setComponentEnabledSetting(entry(wanted), PackageManager.COMPONENT_ENABLED_STATE_ENABLED, PackageManager.DONT_KILL_APP)
      ICON_HUES.indices.filter { it != wanted }.forEach {
        manager.setComponentEnabledSetting(entry(it), PackageManager.COMPONENT_ENABLED_STATE_DISABLED, PackageManager.DONT_KILL_APP)
      }
      prefs.edit().putInt("preset", wanted).remove("wanted").apply()
      Log.i(TAG, "launcher icon switched to entry $wanted")
    } catch (e: Exception) {
      Log.w(TAG, "could not switch the launcher icon", e)
    }
  }
}
