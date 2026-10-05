package com.shibenchi.musicplayer

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.View
import android.webkit.WebView
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import java.lang.ref.WeakReference

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // the app is dark everywhere, so keep the system bars dark with light icons
    enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
      navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT)
    )
    // before the page loads: screens that never reported in last time, or that the apk has caught up with, go
    UiUpdater.startupCheck(applicationContext)
    super.onCreate(savedInstanceState)
    Playback.activity = WeakReference(this)

    // the interface asks this for search results and audio, same as the desktop helper
    MediaHelper.start(this)

    // android 15+ draws apps under the status bar, navigation bar and camera
    // cutout. the interface is laid out from the top of the page, so push the
    // page down and up by the size of those bars (and the keyboard) instead
    val root = findViewById<View>(android.R.id.content)
    root.setBackgroundColor(Color.BLACK)
    ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars()
          or WindowInsetsCompat.Type.displayCutout()
          or WindowInsetsCompat.Type.ime()
      )
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }
  }

  // the page gets a window.SmpNative it uses to tell the notification, the
  // widget and the picture in picture window what is playing
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    Playback.webView = webView
    webView.addJavascriptInterface(NativeBridge(applicationContext), "SmpNative")
  }

  override fun onDestroy() {
    if (Playback.activity?.get() === this) Playback.activity = null
    super.onDestroy()
  }

  // the app is on screen: the mini player goes away
  override fun onStart() {
    super.onStart()
    FloatingPlayer.onAppShown()
  }

  // android pauses a page the moment its activity is hidden, which would stop
  // the player from moving on to the next track with the screen off. while
  // something is playing the page is kept running
  override fun onPause() {
    super.onPause()
    keepPageRunning()
  }

  override fun onStop() {
    super.onStop()
    keepPageRunning()
    // leaving the app while music plays floats the mini player
    FloatingPlayer.onAppLeft(applicationContext)
  }

  private fun keepPageRunning() {
    if (!NowPlaying.playing && !NowPlaying.inRoom) return
    Playback.webView?.let {
      it.onResume()
      it.resumeTimers()
    }
  }

  // ------------------------------------------------------ notifications

  fun askForNotifications() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
    if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
    runOnUiThread { requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1001) }
  }
}
