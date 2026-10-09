package com.shibenchi.musicplayer

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.os.SystemClock
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject
import java.lang.ref.WeakReference
import java.net.HttpURLConnection
import java.net.URL

// everything the native side knows about what is playing. the page owns the real
// player (the audio element lives in the webview), it reports here and the
// notification, the home screen widget and the picture in picture window all
// draw from this one place
object NowPlaying {
  @Volatile var hasTrack = false
  @Volatile var title = ""
  @Volatile var artist = ""
  @Volatile var thumbnail = ""
  @Volatile var playing = false
  @Volatile var positionMs = 0L
  @Volatile var durationMs = 0L
  @Volatile var accent = 0xFFFF5900.toInt()
  @Volatile var shuffle = false
  // 0 off, 1 all, 2 one
  @Volatile var repeat = 0
  // percent, 0 to 100
  @Volatile var volume = 100
  @Volatile var muted = false
  // this device is listening to a room (playing or paused): the room can still start it
  @Volatile var inRoom = false
  // the page is busy getting a song ready (looking it up, loading it, buffering). between two
  // songs this is true, and it is what keeps the service in the foreground
  @Volatile var loading = false
  // when it last played (SystemClock.elapsedRealtime), 0 if it has not since the app started
  @Volatile var lastPlayingAt = 0L

  // when positionMs was true, so the position can be worked out between updates
  @Volatile var stamp = 0L

  fun currentPositionMs(): Long {
    if (!playing) return positionMs
    val moved = SystemClock.elapsedRealtime() - stamp
    val now = positionMs + moved
    return if (durationMs > 0) minOf(now, durationMs) else now
  }

  // the widget can be drawn when the app has just started and nothing is
  // playing yet, so the last state is kept on disk
  fun save(context: Context) {
    context.getSharedPreferences("smp_now_playing", Context.MODE_PRIVATE).edit()
      .putBoolean("hasTrack", hasTrack).putString("title", title).putString("artist", artist)
      .putString("thumbnail", thumbnail).putLong("positionMs", positionMs).putLong("durationMs", durationMs)
      .putInt("accent", accent).putBoolean("shuffle", shuffle).putInt("repeat", repeat)
      .putInt("volume", volume).putBoolean("muted", muted).apply()
  }

  fun restore(context: Context) {
    if (hasTrack) return
    val p = context.getSharedPreferences("smp_now_playing", Context.MODE_PRIVATE)
    hasTrack = p.getBoolean("hasTrack", false)
    title = p.getString("title", "") ?: ""
    artist = p.getString("artist", "") ?: ""
    thumbnail = p.getString("thumbnail", "") ?: ""
    positionMs = p.getLong("positionMs", 0L)
    durationMs = p.getLong("durationMs", 0L)
    accent = p.getInt("accent", accent)
    shuffle = p.getBoolean("shuffle", false)
    repeat = p.getInt("repeat", 0)
    volume = p.getInt("volume", 100)
    muted = p.getBoolean("muted", false)
    playing = false
    stamp = SystemClock.elapsedRealtime()
  }
}

// the other direction: native asking the page to do something
object Playback {
  @Volatile var webView: WebView? = null
  @Volatile var activity: WeakReference<MainActivity>? = null
  @Volatile var inPip = false

  // when the page last reported that the sound really runs (the page says "playing" the moment play is
  // pressed, which is not the same thing when android has frozen it or refuses the audio)
  @Volatile var soundReportedAt = 0L
  // the play being watched, and until when a failed one is not tried again through opening the app
  @Volatile private var playAskedAt = 0L
  @Volatile private var noRetryUntil = 0L

  // the page has loaded and reported a track, so it can answer a command. false while the app is closed
  @Volatile var pageReady = false
  // a button was pressed while there was no page to answer it (the app was closed). the command waits
  // here until the page has loaded its last track, and the app goes back out of sight once the music
  // plays (unless the person touched the app in the meantime)
  @Volatile private var pending: String? = null
  @Volatile private var pendingUntil = 0L
  // until when the app goes back out of sight by itself once the music plays, 0 when it should not
  @Volatile var minimizeUntil = 0L
  private val main = android.os.Handler(android.os.Looper.getMainLooper())

  fun js(code: String) {
    val view = webView ?: return
    // a page whose screen is hidden is paused by android and runs nothing, so a button on the widget or
    // the notification did nothing until the app was opened. it is woken for the command
    view.post {
      view.onResume()
      view.resumeTimers()
      view.evaluateJavascript(code, null)
    }
  }

  // name is previous, next, play, pause or seek (arg is 0..1 of the track)
  fun command(name: String, arg: Double? = null) {
    val extra = if (arg != null) ",$arg" else ""
    js("window.__smpNativeCommand&&window.__smpNativeCommand('$name'$extra)")
    if (name == "play") watchPlay()
  }

  // a play that the page does not answer with sound (android had frozen the page, or refused the audio) is
  // not left looking like it plays on the widget: it goes back to paused and the app is opened, which wakes the
  // page and is allowed to start the sound. once per press
  private fun watchPlay() {
    val asked = SystemClock.elapsedRealtime()
    playAskedAt = asked
    main.postDelayed({
      if (playAskedAt != asked || soundReportedAt >= asked) return@postDelayed
      if (SystemClock.elapsedRealtime() < noRetryUntil) return@postDelayed
      val context = webView?.context?.applicationContext ?: return@postDelayed
      noRetryUntil = SystemClock.elapsedRealtime() + 15_000
      Log.w("SmpBridge", "play was pressed but no sound came, opening the app to start it")
      NowPlaying.positionMs = NowPlaying.currentPositionMs()
      NowPlaying.playing = false
      NowPlaying.stamp = SystemClock.elapsedRealtime()
      PlayerWidget.refresh(context)
      minimizeUntil = SystemClock.elapsedRealtime() + 40_000
      try {
        context.startActivity(launchIntent(context).putExtra("smp_command", "play"))
      } catch (e: Exception) {
        Log.w("SmpBridge", "could not open the app: ${e.message}")
      }
    }, 3_000)
  }

  // the command is run as soon as the page can answer it
  fun commandWhenReady(name: String) {
    if (webView != null && pageReady) {
      command(name)
      return
    }
    pending = name
    pendingUntil = SystemClock.elapsedRealtime() + 30_000
    minimizeUntil = SystemClock.elapsedRealtime() + 40_000
    Log.i("SmpBridge", "no page yet, $name waits for it")
  }

  // called with every report of the page. the first one that has a track in it means the page is up
  fun onPageReport(hasTrack: Boolean) {
    if (!hasTrack) return
    pageReady = true
    val name = pending ?: return
    pending = null
    if (SystemClock.elapsedRealtime() > pendingUntil) return
    Log.i("SmpBridge", "the page is up, running $name")
    // a moment for the page to finish setting the track up
    main.postDelayed({ command(name) }, 500)
  }

  // a button from outside the page (widget, notification, lock screen): answered by the page when it
  // is there, otherwise the app is opened and answers it as soon as it is up
  fun press(context: Context, name: String) {
    if (webView != null && pageReady) {
      command(name)
      return
    }
    commandWhenReady(name)
    try {
      context.startActivity(launchIntent(context))
    } catch (e: Exception) {
      Log.w("SmpBridge", "could not open the app for a button: ${e.message}")
    }
  }

  // the app screen is gone (closed, or replaced): there is no page any more
  fun pageGone() {
    webView = null
    pageReady = false
  }
}

// the intent that opens the app, aimed straight at the main activity. the launcher
// icon is one of twelve entries (see setLauncherIcon) and only one is enabled at a
// time, so asking the system for "the launch intent" gave a different one after each
// color change, and anything made before it (a home screen shortcut, a tap on the
// widget) pointed at an entry that was gone
fun launchIntent(context: Context): Intent =
  Intent(Intent.ACTION_MAIN)
    .addCategory(Intent.CATEGORY_LAUNCHER)
    .setClassName(context.packageName, "com.shibenchi.musicplayer.MainActivity")
    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)

// the hues of the launcher icon colors, in the order of the entries Icon00 to Icon11
// in the manifest
val ICON_HUES = floatArrayOf(0f, 21f, 45f, 75f, 120f, 160f, 185f, 210f, 240f, 270f, 300f, 330f)

// what the page calls as window.SmpNative
class NativeBridge(private val context: Context) {
  @Volatile private var askedForNotifications = false

  @JavascriptInterface
  fun updateState(json: String) {
    try {
      val o = JSONObject(json)
      val wasPlaying = NowPlaying.playing
      NowPlaying.hasTrack = o.optBoolean("hasTrack", false)
      NowPlaying.title = o.optString("title")
      NowPlaying.artist = o.optString("artist")
      NowPlaying.thumbnail = o.optString("thumb")
      NowPlaying.playing = o.optBoolean("playing", false)
      // the sound really runs (screens older than this one do not say, their word for playing is taken)
      if (NowPlaying.playing && o.optBoolean("running", true)) Playback.soundReportedAt = SystemClock.elapsedRealtime()
      NowPlaying.positionMs = (o.optDouble("pos", 0.0) * 1000).toLong()
      NowPlaying.durationMs = (o.optDouble("dur", 0.0) * 1000).toLong()
      NowPlaying.stamp = SystemClock.elapsedRealtime()
      NowPlaying.shuffle = o.optBoolean("shuffle", false)
      NowPlaying.repeat = when (o.optString("repeat")) { "all" -> 1; "one" -> 2; else -> 0 }
      NowPlaying.volume = (o.optDouble("volume", 1.0) * 100).toInt().coerceIn(0, 100)
      NowPlaying.muted = o.optBoolean("muted", false)
      NowPlaying.inRoom = o.optBoolean("inRoom", false)
      NowPlaying.loading = o.optBoolean("loading", false)
      // the moment it stops is remembered too: a song that ended is a stop for a second or two
      if (wasPlaying || NowPlaying.playing) NowPlaying.lastPlayingAt = SystemClock.elapsedRealtime()
      o.optJSONArray("accent")?.let { a ->
        if (a.length() == 3) NowPlaying.accent = 0xFF000000.toInt() or (a.optInt(0) shl 16) or (a.optInt(1) shl 8) or a.optInt(2)
      }
      // first, so the widget and the notification drawn below already know the page is up (a command
      // that waited for it is run here too)
      Playback.onPageReport(NowPlaying.hasTrack)
      NowPlaying.save(context)
      PlaybackService.sync(context)
      PlayerWidget.refresh(context)
      FloatingPlayer.sync(context)
      // the app going back out of sight when a button on the widget or the notification had to open it
      // to start the music
      if (NowPlaying.playing && !wasPlaying && SystemClock.elapsedRealtime() < Playback.minimizeUntil) {
        Playback.minimizeUntil = 0L
        Log.i("SmpBridge", "the music started from a button, the app goes back out of sight (screen: ${Playback.activity?.get() != null})")
        Playback.activity?.get()?.let { screen -> screen.runOnUiThread { screen.moveTaskToBack(true) } }
      }
      Playback.activity?.get()?.let { activity ->
        // asked once, the first time something plays, so the media controls can show
        if (NowPlaying.playing && !wasPlaying && !askedForNotifications) {
          askedForNotifications = true
          activity.askForNotifications()
        }
      }
    } catch (e: Exception) {
      Log.w("SmpBridge", "bad state from the page", e)
    }
  }

  @JavascriptInterface
  fun inPip(): Boolean = Playback.inPip

  // the player that floats over other apps: ready, needs_permission or off
  @JavascriptInterface
  fun floatingStatus(): String = FloatingPlayer.status(context)

  // ---- new screens without a new apk (see UiUpdater.kt)
  // the signed list the server published, as an answer: can this phone take it, and is it newer
  @JavascriptInterface
  fun uiUpdateCheck(envelope: String): String = UiUpdater.check(context, envelope)

  // downloads and switches to the new screens from that server address, returns at once
  @JavascriptInterface
  fun uiUpdateApply(envelope: String, base: String): Boolean = UiUpdater.apply(context, envelope, base)

  // idle, working (done and total files), done or failed (error)
  @JavascriptInterface
  fun uiUpdateState(): String = UiUpdater.state()

  // the page is up and works, the downloaded screens are kept
  @JavascriptInterface
  fun uiConfirm() = UiUpdater.confirm(context)

  // the version of the screens on screen
  @JavascriptInterface
  fun uiVersion(): String = UiUpdater.activeVersion(context)

  // the version of the app itself (the apk), which can be older than the screens
  @JavascriptInterface
  fun appVersion(): String = BuildConfig.VERSION_NAME

  // downloads the apk of the newest version (the signed list says where it is and what its hash
  // is) and hands it to android's installer, returns at once
  @JavascriptInterface
  fun appInstallStart(envelope: String): Boolean = AppInstaller.start(context, envelope)

  // idle, working (done and total bytes), needs_permission, confirm, done or failed (error)
  @JavascriptInterface
  fun appInstallState(): String = AppInstaller.state()

  @JavascriptInterface
  fun setFloatingEnabled(on: Boolean) {
    FloatingPlayer.setEnabled(context, on)
  }

  // for checking how the mini player looks: it drawn into a png (base64)
  @JavascriptInterface
  fun previewMiniPlayer(): String = FloatingPlayer.preview(context)

  // a frame of the page's audio analysis for the mini player's visualizer. returns
  // whether the mini player is showing, the page sends far fewer when it is not
  @JavascriptInterface
  fun vizFrame(text: String): Boolean {
    if (!FloatingPlayer.isShowing()) return false
    Viz.parse(text)
    return true
  }

  // opens the system screen where the person allows display over other apps for
  // this app. nothing is granted without them going through it
  @JavascriptInterface
  fun requestFloatingPermission(): Boolean = try {
    val intent = Intent(
      android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
      android.net.Uri.parse("package:${context.packageName}")
    ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    context.startActivity(intent)
    true
  } catch (e: Exception) {
    Log.w("SmpBridge", "could not open the overlay permission screen", e)
    false
  }

  // asks android to put the player widget on the home screen. the system shows
  // its own box to confirm where, so nothing is placed without the person saying so
  @JavascriptInterface
  fun pinWidget(): Boolean {
    val manager = android.appwidget.AppWidgetManager.getInstance(context)
    if (!manager.isRequestPinAppWidgetSupported) return false
    return manager.requestPinAppWidget(android.content.ComponentName(context, PlayerWidget::class.java), null, null)
  }

  // the launcher icon of the app itself (the one in the app drawer) in the preset
  // color nearest the person's theme color. the manifest has one entry per color and
  // exactly one is enabled, switching them is how an icon can change after install.
  // returns the number of the color now showing. the home screen copy of the icon
  // that was dragged out of the drawer can disappear when the entry it came from is
  // switched off, which is why the shortcut below (updated in place) exists too
  @JavascriptInterface
  fun setLauncherIcon(r: Int, g: Int, b: Int): Int {
    return try {
      val hsv = FloatArray(3)
      android.graphics.Color.RGBToHSV(r.coerceIn(0, 255), g.coerceIn(0, 255), b.coerceIn(0, 255), hsv)
      var best = 0
      var bestGap = Float.MAX_VALUE
      ICON_HUES.forEachIndexed { index, hue ->
        val raw = Math.abs(hsv[0] - hue)
        val gap = Math.min(raw, 360f - raw)
        if (gap < bestGap) { bestGap = gap; best = index }
      }
      // switching the entry the app was opened from closes the app on the spot (android
      // finishes the screen of a component that gets disabled), so it waits until the app
      // is not on screen (see LauncherIcon)
      LauncherIcon.request(context, best)
      best
    } catch (e: Exception) {
      Log.w("SmpBridge", "could not switch the launcher icon", e)
      -1
    }
  }

  // the app's icon on the home screen in the person's color. the page draws the
  // picture and hands it over as a png. a shortcut already on the home screen is
  // updated in place, so a new theme color changes it without it ever vanishing
  // (switching the launcher icon of the app itself would remove it). pin = true
  // also asks android to put one there, the system shows its own box to confirm
  @JavascriptInterface
  fun setShortcutIcon(pngBase64: String, pin: Boolean): Boolean {
    if (android.os.Build.VERSION.SDK_INT < 26) return false
    return try {
      val bytes = android.util.Base64.decode(pngBase64, android.util.Base64.DEFAULT)
      val bitmap = android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return false
      val manager = context.getSystemService(android.content.pm.ShortcutManager::class.java) ?: return false
      val launch = launchIntent(context)
      val info = android.content.pm.ShortcutInfo.Builder(context, "smp_player")
        .setShortLabel("music player")
        .setLongLabel("Shibenchi's Music Player")
        .setIcon(android.graphics.drawable.Icon.createWithAdaptiveBitmap(bitmap))
        .setIntent(launch)
        .build()
      val onHomeScreen = manager.pinnedShortcuts.any { it.id == "smp_player" }
      when {
        onHomeScreen -> { manager.updateShortcuts(listOf(info)); true }
        pin && manager.isRequestPinShortcutSupported -> manager.requestPinShortcut(info, null)
        else -> false
      }
    } catch (e: Exception) {
      Log.w("SmpBridge", "could not set the shortcut icon", e)
      false
    }
  }
}

// buttons on the notification, the widget and the picture in picture window
class MediaActionReceiver : BroadcastReceiver() {
  companion object {
    const val ACTION_PREV = "com.shibenchi.musicplayer.PREV"
    const val ACTION_NEXT = "com.shibenchi.musicplayer.NEXT"
    const val ACTION_TOGGLE = "com.shibenchi.musicplayer.TOGGLE"
    const val ACTION_DISMISS = "com.shibenchi.musicplayer.DISMISS"
    const val ACTION_SHUFFLE = "com.shibenchi.musicplayer.SHUFFLE"
    const val ACTION_REPEAT = "com.shibenchi.musicplayer.REPEAT"
    const val ACTION_MUTE = "com.shibenchi.musicplayer.MUTE"
    const val ACTION_VOL_UP = "com.shibenchi.musicplayer.VOL_UP"
    const val ACTION_VOL_DOWN = "com.shibenchi.musicplayer.VOL_DOWN"
    const val ACTION_SEEK = "com.shibenchi.musicplayer.SEEK"
  }

  // the page confirms every change a moment later, but waiting for that made the
  // widget feel slow. so the button shows its result straight away and the
  // page's report then only has to agree
  private fun showNow(context: Context) {
    PlayerWidget.refresh(context)
  }

  private fun pageIsThere() = Playback.webView != null && Playback.pageReady

  override fun onReceive(context: Context, intent: Intent) {
    when (intent.action) {
      ACTION_PREV -> {
        PlaybackService.beforePlay(context)
        send(context, "previous")
      }
      ACTION_NEXT -> {
        PlaybackService.beforePlay(context)
        send(context, "next")
      }
      ACTION_TOGGLE -> {
        val wasPlaying = NowPlaying.playing
        if (!wasPlaying) PlaybackService.beforePlay(context)
        if (pageIsThere()) {
          NowPlaying.positionMs = NowPlaying.currentPositionMs()
          NowPlaying.stamp = SystemClock.elapsedRealtime()
          NowPlaying.playing = !wasPlaying
          showNow(context)
        }
        send(context, if (wasPlaying) "pause" else "play")
      }
      ACTION_SHUFFLE -> {
        if (pageIsThere()) {
          NowPlaying.shuffle = !NowPlaying.shuffle
          showNow(context)
        }
        send(context, "shuffle")
      }
      ACTION_REPEAT -> {
        if (pageIsThere()) {
          NowPlaying.repeat = (NowPlaying.repeat + 1) % 3
          showNow(context)
        }
        send(context, "repeat")
      }
      ACTION_MUTE -> {
        if (pageIsThere()) {
          NowPlaying.muted = !NowPlaying.muted
          showNow(context)
        }
        send(context, "mute")
      }
      ACTION_VOL_UP -> {
        if (pageIsThere()) {
          NowPlaying.volume = (NowPlaying.volume + 10).coerceAtMost(100)
          NowPlaying.muted = false
          showNow(context)
        }
        send(context, "volume_up")
      }
      ACTION_VOL_DOWN -> {
        if (pageIsThere()) {
          NowPlaying.volume = (NowPlaying.volume - 10).coerceAtLeast(0)
          showNow(context)
        }
        send(context, "volume_down")
      }
      ACTION_SEEK -> {
        val fraction = intent.getDoubleExtra("percent", -1.0)
        if (fraction >= 0 && NowPlaying.hasTrack) {
          if (pageIsThere() && NowPlaying.durationMs > 0) {
            NowPlaying.positionMs = (NowPlaying.durationMs * fraction).toLong()
            NowPlaying.stamp = SystemClock.elapsedRealtime()
            showNow(context)
          }
          Playback.command("seek", fraction)
        }
      }
      ACTION_DISMISS -> PlaybackService.stop()
    }
  }

  // with no page to answer (the app was closed) the best a button can do is open it
  private fun send(context: Context, command: String) {
    Playback.press(context, command)
  }
}

// album art for the notification and the widget. the page hands over a youtube
// thumbnail url, which is a wide picture with black bars above and below, so the
// middle square is what gets used
object ArtLoader {
  @Volatile private var url = ""
  @Volatile private var bitmap: Bitmap? = null

  fun cached(forUrl: String): Bitmap? = if (forUrl == url) bitmap else null

  // blocking, call from a background thread
  fun load(forUrl: String): Bitmap? {
    if (forUrl.isEmpty()) return null
    cached(forUrl)?.let { return it }
    return try {
      val conn = URL(forUrl).openConnection() as HttpURLConnection
      conn.connectTimeout = 6_000
      conn.readTimeout = 8_000
      val raw = conn.inputStream.use { BitmapFactory.decodeStream(it) } ?: return null
      val side = minOf(raw.width, (raw.height * 0.75f).toInt()).coerceAtLeast(1)
      val square = Bitmap.createBitmap(raw, (raw.width - side) / 2, (raw.height - side) / 2, side, side)
      val scaled = if (side > 512) Bitmap.createScaledBitmap(square, 512, 512, true) else square
      url = forUrl
      bitmap = scaled
      scaled
    } catch (e: Exception) {
      Log.i("SmpArt", "art not loaded: ${e.message}")
      null
    }
  }

  @Volatile private var recordKey = ""
  @Volatile private var recordBitmap: Bitmap? = null

  // the vinyl record from the player in the app: a dark disc with the cover faint
  // on it, a rim and glow in the theme color, and a theme colored center. kept
  // until the cover or the color changes, it is not redrawn on every update
  fun record(art: Bitmap?, accent: Int, size: Int): Bitmap {
    val key = "${System.identityHashCode(art)}|$accent|$size"
    if (key == recordKey) recordBitmap?.let { return it }

    val out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(out)
    val c = size / 2f
    val radius = size / 2f - size * 0.07f
    val paint = Paint(Paint.ANTI_ALIAS_FLAG)

    // glow
    paint.style = Paint.Style.FILL
    paint.color = (accent and 0x00FFFFFF) or 0x80000000.toInt()
    paint.maskFilter = android.graphics.BlurMaskFilter(size * 0.045f, android.graphics.BlurMaskFilter.Blur.NORMAL)
    canvas.drawCircle(c, c, radius, paint)
    paint.maskFilter = null

    // disc
    paint.color = 0xFF000000.toInt()
    canvas.drawCircle(c, c, radius, paint)

    // the cover, faint, cropped to the disc
    if (art != null) {
      val d = (radius * 2).toInt().coerceAtLeast(1)
      val scaled = Bitmap.createScaledBitmap(art, d, d, true)
      val path = android.graphics.Path().apply { addCircle(c, c, radius, android.graphics.Path.Direction.CW) }
      canvas.save()
      canvas.clipPath(path)
      paint.alpha = 90
      canvas.drawBitmap(scaled, c - radius, c - radius, paint)
      canvas.restore()
      paint.alpha = 255
    }

    // rim
    paint.style = Paint.Style.STROKE
    paint.strokeWidth = size * 0.012f
    paint.color = accent
    canvas.drawCircle(c, c, radius, paint)

    // center
    paint.style = Paint.Style.FILL
    canvas.drawCircle(c, c, radius * 0.27f, paint)

    recordKey = key
    recordBitmap = out
    return out
  }

  // the round record look the desktop mini player has
  fun circle(source: Bitmap): Bitmap {
    val size = minOf(source.width, source.height)
    val out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(out)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    canvas.drawCircle(size / 2f, size / 2f, size / 2f, paint)
    paint.xfermode = PorterDuffXfermode(PorterDuff.Mode.SRC_IN)
    canvas.drawBitmap(source, ((size - source.width) / 2f), ((size - source.height) / 2f), paint)
    return out
  }
}
