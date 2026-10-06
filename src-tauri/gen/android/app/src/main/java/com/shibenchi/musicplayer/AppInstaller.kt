package com.shibenchi.musicplayer

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicBoolean

// installing a new version of the app from inside the app, after the person pressed update.
// the apk is downloaded from the project's github release (the address, size and hash come from
// the manifest the maker signed, see UiUpdater.verified, so a server that was taken over can not
// hand out another file), checked against that hash, and handed to android's installer. android
// asks the person once more and also refuses an apk that is not signed with the same key as this
// app. the app is closed by the installer when it replaces itself, UpdateReceiver opens it again
object AppInstaller {
  private const val TAG = "SmpInstall"
  private const val RELEASE_PREFIX = "https://github.com/shibenchi/Shibenchis-Music-Player/releases/download/"
  private val NAME = Regex("^Shibenchis-Music-Player_[0-9A-Za-z.-]{1,32}\\.apk$")
  private const val MAX_BYTES = 150L * 1024 * 1024
  const val ACTION_RESULT = "com.shibenchi.musicplayer.INSTALL_RESULT"

  private val busy = AtomicBoolean(false)
  @Volatile private var progress: JSONObject = JSONObject().put("state", "idle")

  // idle, working (done and total bytes), needs_permission, confirm (android is asking the person),
  // done or failed (error)
  fun state(): String = progress.toString()

  fun setState(state: String, message: String? = null) {
    progress = JSONObject().put("state", state).apply { if (message != null) put("error", message) }
  }

  private fun dir(context: Context) = File(context.cacheDir, "updates")

  // the downloaded apk is not needed once the new version runs
  fun cleanup(context: Context) {
    try { dir(context).deleteRecursively() } catch (e: Exception) { /* left for next time */ }
  }

  private fun allowed(url: String): Boolean {
    if (url.startsWith(RELEASE_PREFIX)) return true
    // debug builds can be pointed at a test server on this computer (adb reverse)
    return BuildConfig.DEBUG && (url.startsWith("http://127.0.0.1:") || url.startsWith("http://localhost:"))
  }

  // true if the download started, false if one is already running
  fun start(context: Context, envelope: String): Boolean {
    if (!busy.compareAndSet(false, true)) return false
    progress = JSONObject().put("state", "working").put("done", 0).put("total", 0)
    Thread {
      try {
        val manifest = UiUpdater.verified(envelope) ?: throw IllegalStateException("not signed by the maker")
        val version = manifest.getString("version")
        if (UiUpdater.compareVersions(version, BuildConfig.VERSION_NAME) <= 0) throw IllegalStateException("already up to date")
        val entry = manifest.optJSONObject("installers")?.optJSONObject("android")
          ?: throw IllegalStateException("this update has no apk to download")
        val url = entry.getString("url")
        val size = entry.getLong("size")
        val hash = entry.getString("sha256").lowercase()
        if (!allowed(url)) throw IllegalStateException("the apk is not on the project's releases")
        val name = Uri.parse(url).lastPathSegment ?: ""
        if (!NAME.matches(name) && !BuildConfig.DEBUG) throw IllegalStateException("the apk has an unexpected name")
        if (size < 1 || size > MAX_BYTES || !hash.matches(Regex("^[0-9a-f]{64}$"))) throw IllegalStateException("the apk entry is not valid")

        // asked before the download: the person has to allow installs from this app once, in a
        // system screen. opened here, then they press update again
        if (!context.packageManager.canRequestPackageInstalls()) {
          progress = JSONObject().put("state", "needs_permission")
          context.startActivity(
            Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
              .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          )
          return@Thread
        }

        val folder = dir(context)
        folder.deleteRecursively()
        folder.mkdirs()
        val file = File(folder, "update.apk")
        val digest = MessageDigest.getInstance("SHA-256")
        var count = 0L
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
          conn.connectTimeout = 15_000
          conn.readTimeout = 30_000
          if (conn.responseCode != 200) throw IllegalStateException("the download answered ${conn.responseCode}")
          FileOutputStream(file).use { output ->
            conn.inputStream.use { input ->
              val buffer = ByteArray(64 * 1024)
              var lastReport = 0L
              while (true) {
                val n = input.read(buffer)
                if (n < 0) break
                count += n
                if (count > size) throw IllegalStateException("the apk is bigger than it should be")
                digest.update(buffer, 0, n)
                output.write(buffer, 0, n)
                val now = System.currentTimeMillis()
                if (now - lastReport > 250) {
                  lastReport = now
                  progress = JSONObject().put("state", "working").put("done", count).put("total", size)
                }
              }
            }
          }
        } finally {
          conn.disconnect()
        }
        if (count != size) throw IllegalStateException("the apk has the wrong size")
        val actual = digest.digest().joinToString("") { "%02x".format(it) }
        if (actual != hash) throw IllegalStateException("the apk does not match its hash")

        install(context, file)
        Log.i(TAG, "update to $version handed to the installer")
      } catch (e: Exception) {
        Log.w(TAG, "install failed: ${e.message}")
        // a half written or rejected file is not kept
        if (progress.optString("state") != "needs_permission") cleanup(context)
        progress = JSONObject().put("state", "failed").put("error", e.message ?: "failed")
      } finally {
        busy.set(false)
      }
    }.start()
    return true
  }

  // hands the checked file to android's installer. the result comes back to InstallResultReceiver
  private fun install(context: Context, file: File) {
    val installer = context.packageManager.packageInstaller
    val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
    // only this app can be replaced by it
    params.setAppPackageName(context.packageName)
    params.setSize(file.length())
    // where android allows it the person is not asked again
    if (Build.VERSION.SDK_INT >= 31) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
    val sessionId = installer.createSession(params)
    installer.openSession(sessionId).use { session ->
      session.openWrite("smp-update.apk", 0, file.length()).use { out ->
        file.inputStream().use { it.copyTo(out) }
        session.fsync(out)
      }
      val intent = Intent(context, InstallResultReceiver::class.java).setAction(ACTION_RESULT).setPackage(context.packageName)
      val pending = PendingIntent.getBroadcast(context, sessionId, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
      progress = JSONObject().put("state", "confirm")
      session.commit(pending.intentSender)
    }
  }
}

// android's answer to the install. when it wants the person to say yes it hands over the screen
// to show (the app is on screen, the person just pressed update)
class InstallResultReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, -1)
    val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
    when (status) {
      PackageInstaller.STATUS_PENDING_USER_ACTION -> {
        @Suppress("DEPRECATION")
        val confirm = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java) else intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
        if (confirm == null) {
          AppInstaller.setState("failed", "android did not say what to show")
          return
        }
        try {
          confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          context.startActivity(confirm)
          AppInstaller.setState("confirm")
        } catch (e: Exception) {
          Log.w("SmpInstall", "could not show the install screen: ${e.message}")
          AppInstaller.setState("failed", "could not show the install screen")
        }
      }
      PackageInstaller.STATUS_SUCCESS -> AppInstaller.setState("done")
      PackageInstaller.STATUS_FAILURE_ABORTED -> {
        AppInstaller.cleanup(context)
        AppInstaller.setState("failed", "the install was cancelled")
      }
      else -> {
        AppInstaller.cleanup(context)
        AppInstaller.setState("failed", message ?: "android refused the install")
      }
    }
  }
}

// after the app has been replaced by a new version: the download is removed and the app opens
// again. android does not let an app start a screen from the background, except with the permission
// to display over other apps, so without it a notification says the app was updated
class UpdateReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
    AppInstaller.cleanup(context)
    try {
      if (Settings.canDrawOverlays(context)) {
        context.startActivity(launchIntent(context))
        return
      }
    } catch (e: Exception) {
      Log.w("SmpInstall", "could not open the app after the update: ${e.message}")
    }
    try {
      val manager = context.getSystemService(NotificationManager::class.java)
      manager.createNotificationChannel(NotificationChannel("updates", "updates", NotificationManager.IMPORTANCE_DEFAULT))
      val open = PendingIntent.getActivity(context, 0, launchIntent(context), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
      val notification = Notification.Builder(context, "updates")
        .setSmallIcon(R.drawable.ic_stat_music)
        .setContentTitle("updated to ${BuildConfig.VERSION_NAME}")
        .setContentText("tap to open")
        .setContentIntent(open)
        .setAutoCancel(true)
        .build()
      manager.notify(4243, notification)
    } catch (e: Exception) {
      Log.w("SmpInstall", "could not post the updated notification: ${e.message}")
    }
  }
}
