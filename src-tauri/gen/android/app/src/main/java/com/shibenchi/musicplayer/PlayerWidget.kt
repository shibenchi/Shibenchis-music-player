package com.shibenchi.musicplayer

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.Paint
import android.graphics.Typeface
import android.os.Build
import android.util.TypedValue
import android.widget.RemoteViews

// the home screen player, 4x4: the same card as the player in the app, a bit
// smaller. vinyl record, title and artist, progress with its times, shuffle,
// previous, play or pause, next and repeat, and a volume row. it shows the last
// thing the app reported, so it still has something to show after a restart
class PlayerWidget : AppWidgetProvider() {
  companion object {
    // a button that is switched off, dimmed white
    private const val OFF = 0x66FFFFFF

    private fun ids(context: Context): IntArray {
      val manager = AppWidgetManager.getInstance(context)
      return manager.getAppWidgetIds(ComponentName(context, PlayerWidget::class.java))
    }

    fun refresh(context: Context) {
      val ids = ids(context)
      if (ids.isEmpty()) return
      AppWidgetManager.getInstance(context).updateAppWidget(ids, build(context))
    }

    // a title that is too long for the widget scrolls: it holds still for a moment,
    // then moves along a letter at a time and comes back round to the start. a
    // widget cannot run an animation of its own (android does not allow the
    // marquee call on one), so the text is moved here a few times a second
    private const val GAP = "     "
    private const val HOLD_TICKS = 5

    private class Scroller(val sizeSp: Float, val bold: Boolean) {
      var text = ""
      var offset = 0
      var hold = HOLD_TICKS

      fun paint(context: Context): Paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textSize = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, sizeSp, context.resources.displayMetrics)
        typeface = if (bold) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
      }

      fun set(newText: String) {
        if (newText == text) return
        text = newText
        offset = 0
        hold = HOLD_TICKS
      }

      fun isLong(paint: Paint, widthPx: Float) = text.isNotEmpty() && paint.measureText(text) > widthPx

      // what is showing right now: the whole text if it fits, otherwise the part
      // of the endless loop that starts at the current offset
      fun view(paint: Paint, widthPx: Float): String {
        if (!isLong(paint, widthPx)) return text
        val loop = text + GAP
        val doubled = loop + loop
        var end = offset
        while (end < doubled.length && paint.measureText(doubled, offset, end + 1) <= widthPx) end++
        return doubled.substring(offset, end)
      }

      fun advance(paint: Paint, widthPx: Float) {
        if (!isLong(paint, widthPx)) return
        if (hold > 0) {
          hold--
          return
        }
        offset++
        if (offset >= text.length + GAP.length) {
          offset = 0
          hold = HOLD_TICKS
        }
      }
    }

    private val titleScroller = Scroller(15f, true)
    private val artistScroller = Scroller(12f, false)
    private var lastProgressAt = 0L

    // the room the text has: the narrowest widget on the screen, less its padding
    private fun textWidthPx(context: Context): Float {
      val manager = AppWidgetManager.getInstance(context)
      var narrowest = Int.MAX_VALUE
      for (id in ids(context)) {
        val dp = manager.getAppWidgetOptions(id).getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 250)
        if (dp in 1 until narrowest) narrowest = dp
      }
      if (narrowest == Int.MAX_VALUE) narrowest = 250
      return TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, (narrowest - 46).toFloat(), context.resources.displayMetrics)
    }

    private fun shownTitle() = NowPlaying.title.ifEmpty { "nothing playing" }
    private fun shownArtist() = NowPlaying.artist.ifEmpty { "open the app and pick a track" }

    // a few times a second while music plays on a lit screen: the scrolling text,
    // and once a second the progress line and times. small updates that leave the
    // record alone
    fun tick(context: Context) {
      val ids = ids(context)
      if (ids.isEmpty()) return
      val manager = AppWidgetManager.getInstance(context)
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
        manager.updateAppWidget(ids, build(context))
        return
      }
      val views = RemoteViews(context.packageName, R.layout.widget_player)
      var changed = false

      val width = textWidthPx(context)
      titleScroller.set(shownTitle())
      artistScroller.set(shownArtist())
      val titlePaint = titleScroller.paint(context)
      val artistPaint = artistScroller.paint(context)
      if (titleScroller.isLong(titlePaint, width)) {
        titleScroller.advance(titlePaint, width)
        views.setTextViewText(R.id.widget_title, titleScroller.view(titlePaint, width))
        changed = true
      }
      if (artistScroller.isLong(artistPaint, width)) {
        artistScroller.advance(artistPaint, width)
        views.setTextViewText(R.id.widget_artist, artistScroller.view(artistPaint, width))
        changed = true
      }

      val now = System.currentTimeMillis()
      if (now - lastProgressAt >= 1000) {
        lastProgressAt = now
        progress(views)
        changed = true
      }
      if (changed) manager.partiallyUpdateAppWidget(ids, views)
    }

    private fun clock(ms: Long): String {
      val total = (ms / 1000).coerceAtLeast(0)
      return "${total / 60}:${(total % 60).toString().padStart(2, '0')}"
    }

    private fun progress(views: RemoteViews) {
      val duration = NowPlaying.durationMs
      val position = NowPlaying.currentPositionMs()
      views.setProgressBar(R.id.widget_progress, 1000, if (duration > 0) (position * 1000 / duration).toInt().coerceIn(0, 1000) else 0, false)
      views.setTextViewText(R.id.widget_time_now, clock(position))
      views.setTextViewText(R.id.widget_time_total, if (duration > 0) clock(duration) else "--:--")
    }

    private fun broadcast(context: Context, code: Int, action: String): PendingIntent = PendingIntent.getBroadcast(
      context, code,
      Intent(context, MediaActionReceiver::class.java).setAction(action).setPackage(context.packageName),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    )

    // a button that needs the page. with the page there it is answered at once, in the background.
    // with the app closed there is no page, so the button opens the app with the command in it, and
    // the app answers it as soon as it is up and goes back out of sight once the music plays. the
    // widget is drawn again whenever the page comes or goes, so this is always the right kind
    private fun control(context: Context, code: Int, action: String, command: String): PendingIntent {
      if (Playback.webView != null && Playback.pageReady) return broadcast(context, code, action)
      return PendingIntent.getActivity(
        context, 200 + code, launchIntent(context).putExtra("smp_command", command),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
      )
    }

    private fun build(context: Context): RemoteViews {
      NowPlaying.restore(context)
      val accent = NowPlaying.accent
      val views = RemoteViews(context.packageName, R.layout.widget_player)

      // the text as the scroller has it right now, so a full redraw does not
      // jump the scrolling text back to the start
      val width = textWidthPx(context)
      titleScroller.set(shownTitle())
      artistScroller.set(shownArtist())
      views.setTextViewText(R.id.widget_title, titleScroller.view(titleScroller.paint(context), width))
      views.setTextViewText(R.id.widget_artist, artistScroller.view(artistScroller.paint(context), width))
      progress(views)

      // the outline and the progress line take the theme color
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        views.setColorStateList(R.id.widget_root, "setBackgroundTintList", ColorStateList.valueOf(accent))
        views.setColorStateList(R.id.widget_progress, "setProgressTintList", ColorStateList.valueOf(accent))
      } else {
        views.setInt(R.id.widget_root, "setBackgroundColor", accent)
      }

      // the record, drawn like the one in the app: a dark disc with the cover
      // faint on it, a theme colored rim, glow and center
      val record = ArtLoader.record(ArtLoader.cached(NowPlaying.thumbnail), accent, 480)
      views.setImageViewBitmap(R.id.widget_art, record)
      views.setInt(R.id.widget_art, "setColorFilter", 0)

      // the controls
      views.setImageViewResource(R.id.widget_toggle, if (NowPlaying.playing) R.drawable.ic_pause else R.drawable.ic_play)
      views.setImageViewResource(R.id.widget_repeat, if (NowPlaying.repeat == 2) R.drawable.ic_repeat_one else R.drawable.ic_repeat)
      views.setImageViewResource(R.id.widget_mute, if (NowPlaying.muted) R.drawable.ic_volume_off else R.drawable.ic_volume_up)
      for (id in intArrayOf(R.id.widget_prev, R.id.widget_toggle, R.id.widget_next, R.id.widget_vol_down, R.id.widget_vol_up)) {
        views.setInt(id, "setColorFilter", accent)
      }
      views.setInt(R.id.widget_shuffle, "setColorFilter", if (NowPlaying.shuffle) accent else OFF)
      views.setInt(R.id.widget_repeat, "setColorFilter", if (NowPlaying.repeat != 0) accent else OFF)
      views.setInt(R.id.widget_mute, "setColorFilter", if (NowPlaying.muted) OFF else accent)
      views.setTextViewText(R.id.widget_volume, if (NowPlaying.muted) "muted" else "${NowPlaying.volume}%")
      views.setTextColor(R.id.widget_volume, if (NowPlaying.muted) OFF else 0xFFFEF3E2.toInt())

      views.setOnClickPendingIntent(R.id.widget_shuffle, broadcast(context, 10, MediaActionReceiver.ACTION_SHUFFLE))
      views.setOnClickPendingIntent(R.id.widget_prev, control(context, 11, MediaActionReceiver.ACTION_PREV, "previous"))
      views.setOnClickPendingIntent(R.id.widget_toggle, control(context, 12, MediaActionReceiver.ACTION_TOGGLE, if (NowPlaying.playing) "pause" else "play"))
      views.setOnClickPendingIntent(R.id.widget_next, control(context, 13, MediaActionReceiver.ACTION_NEXT, "next"))
      views.setOnClickPendingIntent(R.id.widget_repeat, broadcast(context, 14, MediaActionReceiver.ACTION_REPEAT))
      views.setOnClickPendingIntent(R.id.widget_mute, broadcast(context, 15, MediaActionReceiver.ACTION_MUTE))
      views.setOnClickPendingIntent(R.id.widget_vol_down, broadcast(context, 16, MediaActionReceiver.ACTION_VOL_DOWN))
      views.setOnClickPendingIntent(R.id.widget_vol_up, broadcast(context, 17, MediaActionReceiver.ACTION_VOL_UP))

      // the progress line is twenty tap zones, each one jumps to its spot in the song
      val seekZones = intArrayOf(
        R.id.widget_seek_0, R.id.widget_seek_1, R.id.widget_seek_2, R.id.widget_seek_3, R.id.widget_seek_4,
        R.id.widget_seek_5, R.id.widget_seek_6, R.id.widget_seek_7, R.id.widget_seek_8, R.id.widget_seek_9,
        R.id.widget_seek_10, R.id.widget_seek_11, R.id.widget_seek_12, R.id.widget_seek_13, R.id.widget_seek_14,
        R.id.widget_seek_15, R.id.widget_seek_16, R.id.widget_seek_17, R.id.widget_seek_18, R.id.widget_seek_19
      )
      for ((i, id) in seekZones.withIndex()) {
        // the data makes each one a different intent, otherwise android would treat
        // all twenty as the same button
        val intent = Intent(context, MediaActionReceiver::class.java)
          .setAction(MediaActionReceiver.ACTION_SEEK)
          .setPackage(context.packageName)
          .setData(android.net.Uri.parse("smp://seek/$i"))
          .putExtra("percent", (i + 0.5) / seekZones.size)
        views.setOnClickPendingIntent(
          id,
          PendingIntent.getBroadcast(context, 100 + i, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        )
      }

      // the record and the title open the app
      val open = launchIntent(context)
      run {
        val pending = PendingIntent.getActivity(context, 20, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        views.setOnClickPendingIntent(R.id.widget_art, pending)
        views.setOnClickPendingIntent(R.id.widget_title, pending)
        views.setOnClickPendingIntent(R.id.widget_artist, pending)
      }
      return views
    }
  }

  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
    manager.updateAppWidget(ids, build(context))
  }

  // resized, or moved onto another page: draw it again so nothing is left over
  // from the layout the launcher started it with
  override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, newOptions: android.os.Bundle) {
    manager.updateAppWidget(id, build(context))
  }

  override fun onEnabled(context: Context) {
    refresh(context)
  }
}
