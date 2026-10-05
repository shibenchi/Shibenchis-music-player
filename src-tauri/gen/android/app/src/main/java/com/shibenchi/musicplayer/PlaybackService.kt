package com.shibenchi.musicplayer

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.core.content.ContextCompat

// keeps the music going with the screen off and shows the media notification:
// album art, title, and previous, play or pause and next. the same notification
// is what appears on the lock screen and in the quick settings panel. the audio
// itself still plays in the page, this only holds the process up and shows the
// controls
class PlaybackService : Service() {
  companion object {
    private const val CHANNEL = "playback"
    private const val NOTIFICATION_ID = 4242

    @Volatile private var instance: PlaybackService? = null

    // a button on the notification, the widget or the lock screen is about to start
    // music. with battery saver on, android cuts the network of an app in the
    // background unless it holds a foreground service, and the page needs the
    // network the moment it starts the song. so the service is brought up first,
    // while the button press still counts as the user's own action
    @Volatile private var holdUntil = 0L

    fun beforePlay(context: Context) {
      if (!NowPlaying.hasTrack) return
      holdUntil = System.currentTimeMillis() + 20_000
      val running = instance
      if (running != null) {
        running.refresh()
        running.main.postDelayed({ running.refresh() }, 21_000)
        return
      }
      try {
        ContextCompat.startForegroundService(context, Intent(context, PlaybackService::class.java))
      } catch (e: Exception) {
        Log.w("SmpService", "could not start the playback service for a play button: ${e.message}")
      }
    }

    // called whenever the page reports a change
    fun sync(context: Context) {
      val running = instance
      if (!NowPlaying.hasTrack) {
        stop()
        return
      }
      if (running != null) {
        running.refresh()
        return
      }
      // a track that is only loaded (the app just opened on the last one) has
      // nothing to keep the process up for, the service starts with the music
      if (!NowPlaying.playing && !NowPlaying.inRoom && System.currentTimeMillis() >= holdUntil) return
      try {
        ContextCompat.startForegroundService(context, Intent(context, PlaybackService::class.java))
      } catch (e: Exception) {
        // android refuses to start one from the background in a few cases
        Log.w("SmpService", "could not start the playback service: ${e.message}")
      }
    }

    fun stop() {
      instance?.requestStop()
    }
  }

  // android crashes an app whose service is stopped before it has called
  // startForeground, so a stop that arrives that early waits for it
  private var foregroundStarted = false
  private var stopWhenReady = false

  fun requestStop() {
    if (!foregroundStarted) {
      stopWhenReady = true
      return
    }
    stopForeground(Service.STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  private lateinit var session: MediaSession
  val main = Handler(Looper.getMainLooper())
  private var artUrl = ""

  override fun onCreate() {
    super.onCreate()
    instance = this
    val nm = getSystemService(NotificationManager::class.java)
    nm.createNotificationChannel(
      NotificationChannel(CHANNEL, getString(R.string.playback_channel), NotificationManager.IMPORTANCE_LOW).apply {
        setShowBadge(false)
        lockscreenVisibility = Notification.VISIBILITY_PUBLIC
      }
    )
    session = MediaSession(this, "ShibenchiPlayer").apply {
      setCallback(object : MediaSession.Callback() {
        override fun onPlay() {
          beforePlay(this@PlaybackService)
          Playback.command("play")
        }
        override fun onPause() = Playback.command("pause")
        override fun onSkipToNext() {
          beforePlay(this@PlaybackService)
          Playback.command("next")
        }
        override fun onSkipToPrevious() {
          beforePlay(this@PlaybackService)
          Playback.command("previous")
        }
        override fun onSeekTo(pos: Long) {
          val duration = NowPlaying.durationMs
          if (duration > 0) Playback.command("seek", (pos.toDouble() / duration).coerceIn(0.0, 1.0))
        }
      })
      isActive = true
    }
    // android wants a foreground notification within seconds of starting
    startForegroundCompat(buildNotification())
    foregroundStarted = true
    if (stopWhenReady) requestStop()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    refresh()
    return START_NOT_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onDestroy() {
    FloatingPlayer.hide()
    main.removeCallbacks(ticker)
    instance = null
    session.isActive = false
    session.release()
    super.onDestroy()
  }

  private fun startForegroundCompat(notification: Notification) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  private val ticker = object : Runnable {
    override fun run() {
      if (!NowPlaying.playing) return
      val power = getSystemService(android.os.PowerManager::class.java)
      val screenOn = power.isInteractive
      if (screenOn) PlayerWidget.tick(this@PlaybackService)
      // with the screen off nobody looks at the widget, a slow check is enough
      main.postDelayed(this, if (screenOn) 300 else 2000)
    }
  }

  fun refresh() {
    main.removeCallbacks(ticker)
    if (NowPlaying.playing) main.postDelayed(ticker, 300)
    ensureArt()
    val art = ArtLoader.cached(NowPlaying.thumbnail)

    session.setMetadata(
      MediaMetadata.Builder()
        .putString(MediaMetadata.METADATA_KEY_TITLE, NowPlaying.title)
        .putString(MediaMetadata.METADATA_KEY_ARTIST, NowPlaying.artist)
        .putLong(MediaMetadata.METADATA_KEY_DURATION, NowPlaying.durationMs)
        .apply { if (art != null) putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, art) }
        .build()
    )
    session.setPlaybackState(
      PlaybackState.Builder()
        .setActions(
          PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_PLAY_PAUSE or
            PlaybackState.ACTION_SKIP_TO_NEXT or PlaybackState.ACTION_SKIP_TO_PREVIOUS or PlaybackState.ACTION_SEEK_TO
        )
        .setState(
          if (NowPlaying.playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED,
          NowPlaying.positionMs,
          if (NowPlaying.playing) 1f else 0f
        )
        .build()
    )

    val notification = buildNotification()
    if (NowPlaying.playing || NowPlaying.inRoom || System.currentTimeMillis() < holdUntil) {
      startForegroundCompat(notification)
    } else {
      // paused: the notification stays but can be swiped away
      stopForeground(Service.STOP_FOREGROUND_DETACH)
      getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification)
    }
  }

  private fun ensureArt() {
    val url = NowPlaying.thumbnail
    if (url == artUrl) return
    artUrl = url
    if (url.isEmpty()) return
    Thread {
      ArtLoader.load(url)
      if (url == NowPlaying.thumbnail) {
        main.post { refresh() }
        PlayerWidget.refresh(this)
      }
    }.start()
  }

  private fun broadcast(code: Int, action: String): PendingIntent = PendingIntent.getBroadcast(
    this, code,
    Intent(this, MediaActionReceiver::class.java).setAction(action).setPackage(packageName),
    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
  )

  private fun buildNotification(): Notification {
    val launch = launchIntent(this)
    val open = PendingIntent.getActivity(
      this, 0, launch.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    )
    fun action(icon: Int, label: String, pending: PendingIntent) =
      Notification.Action.Builder(Icon.createWithResource(this, icon), label, pending).build()

    val builder = Notification.Builder(this, CHANNEL)
      .setSmallIcon(R.drawable.ic_stat_music)
      .setContentTitle(NowPlaying.title.ifEmpty { "nothing playing" })
      .setContentText(NowPlaying.artist)
      .setContentIntent(open)
      .setDeleteIntent(broadcast(4, MediaActionReceiver.ACTION_DISMISS))
      .setVisibility(Notification.VISIBILITY_PUBLIC)
      .setCategory(Notification.CATEGORY_TRANSPORT)
      .setOnlyAlertOnce(true)
      .setShowWhen(false)
      .setOngoing(NowPlaying.playing)
      .setColor(NowPlaying.accent)
      .addAction(action(R.drawable.ic_prev, "previous", broadcast(1, MediaActionReceiver.ACTION_PREV)))
      .addAction(
        if (NowPlaying.playing) action(R.drawable.ic_pause, "pause", broadcast(2, MediaActionReceiver.ACTION_TOGGLE))
        else action(R.drawable.ic_play, "play", broadcast(2, MediaActionReceiver.ACTION_TOGGLE))
      )
      .addAction(action(R.drawable.ic_next, "next", broadcast(3, MediaActionReceiver.ACTION_NEXT)))
      .setStyle(Notification.MediaStyle().setMediaSession(session.sessionToken).setShowActionsInCompactView(0, 1, 2))
    ArtLoader.cached(NowPlaying.thumbnail)?.let { builder.setLargeIcon(it) }
    return builder.build()
  }
}
