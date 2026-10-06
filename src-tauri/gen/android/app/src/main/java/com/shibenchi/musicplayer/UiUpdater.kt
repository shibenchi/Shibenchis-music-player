package com.shibenchi.musicplayer

import android.content.Context
import android.util.Base64
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.util.concurrent.atomic.AtomicBoolean

// updating the screens of the app (the interface, the part you see and tap) without installing a
// new apk. the club server publishes a signed list of the newest files (the same one the desktop
// app uses), this checks the signature and every file's hash, keeps the files in the app's own
// folder and the rust side serves them instead of the ones packed into the apk (see mobile.rs).
// only the interface can change like this, anything native still needs an apk.
//
// a set of screens that never reports in (the page calls uiConfirm a few seconds after it has
// loaded) is dropped at the next start and the app goes back to the screens in the apk, so a
// broken update can not lock anyone out
object UiUpdater {
  private const val TAG = "SmpUi"
  // the maker's public key, the same one the desktop app has
  private const val PUBLIC_KEY = "MCowBQYDK2VwAyEAWEpnNncXYfK8hZcPBwkGBZMsE8Z5XfTJIUb9ok6McJw="
  private const val MAX_FILES = 600
  private const val MAX_FILE_BYTES = 30L * 1024 * 1024
  private const val MAX_TOTAL_BYTES = 80L * 1024 * 1024

  private val busy = AtomicBoolean(false)
  @Volatile private var progress: JSONObject = JSONObject().put("state", "idle")

  private fun root(context: Context) = File(context.filesDir, "ui-update")

  fun compareVersions(a: String, b: String): Int {
    val pa = a.split('.').map { it.filter(Char::isDigit).toIntOrNull() ?: 0 }
    val pb = b.split('.').map { it.filter(Char::isDigit).toIntOrNull() ?: 0 }
    for (i in 0 until maxOf(pa.size, pb.size, 3)) {
      val diff = pa.getOrElse(i) { 0 } - pb.getOrElse(i) { 0 }
      if (diff != 0) return if (diff > 0) 1 else -1
    }
    return 0
  }

  // the downloaded screens in use, if there are any: their version and folder
  private fun readMeta(context: Context): Pair<String, File>? {
    return try {
      val base = root(context)
      val meta = JSONObject(File(base, "meta.json").readText())
      val folder = meta.getString("folder")
      if (folder.isEmpty() || folder.contains('/') || folder.contains("..")) return null
      val dir = File(base, folder)
      if (File(dir, "index.html").isFile) Pair(meta.getString("version"), dir) else null
    } catch (e: Exception) {
      null
    }
  }

  // the version of the screens that are on screen: the downloaded ones or the ones in the apk
  fun activeVersion(context: Context): String = readMeta(context)?.first ?: BuildConfig.VERSION_NAME

  // at app start, before the page loads
  fun startupCheck(context: Context) {
    try {
      val dir = root(context)
      if (!dir.exists()) return
      if (File(dir, "pending").exists()) {
        Log.w(TAG, "the downloaded screens never reported in, back to the ones in the app")
        dir.deleteRecursively()
        return
      }
      val meta = readMeta(context)
      // an apk that is as new as the download (or newer) has the screens itself
      if (meta == null || compareVersions(meta.first, BuildConfig.VERSION_NAME) <= 0) {
        dir.deleteRecursively()
        return
      }
      dir.listFiles { f -> f.name.endsWith(".partial") }?.forEach { it.deleteRecursively() }
    } catch (e: Exception) {
      Log.w(TAG, "start check failed: ${e.message}")
    }
  }

  // the page loaded the new screens and they work
  fun confirm(context: Context) {
    try { File(root(context), "pending").delete() } catch (e: Exception) { /* nothing to do */ }
  }

  // the manifest if its signature is the maker's, null if not
  fun verified(envelope: String): JSONObject? {
    val env = JSONObject(envelope)
    val text = env.getString("manifest")
    val signature = Base64.decode(env.getString("signature"), Base64.DEFAULT)
    val key = KeyFactory.getInstance("Ed25519").generatePublic(X509EncodedKeySpec(Base64.decode(PUBLIC_KEY, Base64.DEFAULT)))
    val check = Signature.getInstance("Ed25519")
    check.initVerify(key)
    check.update(text.toByteArray(Charsets.UTF_8))
    if (!check.verify(signature)) return null
    return JSONObject(text)
  }

  // what the page was handed by the server, as an answer: can this phone take it, and is it newer
  fun check(context: Context, envelope: String): String {
    return try {
      val manifest = verified(envelope) ?: return JSONObject().put("ok", false).put("error", "not signed by the maker").toString()
      val version = manifest.getString("version")
      val minShell = manifest.optString("minShell").ifEmpty { version }
      JSONObject()
        .put("ok", true)
        .put("latest", version)
        .put("newer", compareVersions(version, activeVersion(context)) > 0)
        .put("canApply", compareVersions(BuildConfig.VERSION_NAME, minShell) >= 0)
        // this version has an apk the app can download and install itself (see AppInstaller)
        .put("installer", manifest.optJSONObject("installers")?.optJSONObject("android") != null)
        .toString()
    } catch (e: java.security.NoSuchAlgorithmException) {
      JSONObject().put("ok", false).put("error", "this Android can not check the signature").toString()
    } catch (e: Exception) {
      JSONObject().put("ok", false).put("error", e.message ?: "bad manifest").toString()
    }
  }

  fun state(): String = progress.toString()

  private fun safeRelative(value: String): String? {
    val text = value.replace('\\', '/')
    if (text.isEmpty() || text.startsWith("/") || text.contains(':') || text.contains('\u0000')) return null
    val parts = text.split('/')
    if (parts.any { it.isEmpty() || it == "." || it == ".." }) return null
    return parts.joinToString("/")
  }

  private fun allowedBase(base: String): Boolean {
    if (base.startsWith("https://") && !base.substring(8).contains('@')) return true
    // debug builds can be pointed at a test server on this computer (adb reverse)
    return BuildConfig.DEBUG && (base.startsWith("http://127.0.0.1:") || base.startsWith("http://localhost:"))
  }

  // downloads the files of the manifest from the base address and switches to them. returns at
  // once, the state says how it is going. the page then reloads itself
  fun apply(context: Context, envelope: String, rawBase: String): Boolean {
    val base = rawBase.trim().trimEnd('/')
    if (!allowedBase(base)) {
      progress = JSONObject().put("state", "failed").put("error", "that address is not allowed")
      return false
    }
    if (!busy.compareAndSet(false, true)) return false
    progress = JSONObject().put("state", "working").put("done", 0).put("total", 0)
    Thread {
      var staging: File? = null
      try {
        val manifest = verified(envelope) ?: throw IllegalStateException("not signed by the maker")
        val version = manifest.getString("version")
        val minShell = manifest.optString("minShell").ifEmpty { version }
        if (compareVersions(version, activeVersion(context)) <= 0) throw IllegalStateException("already up to date")
        if (compareVersions(BuildConfig.VERSION_NAME, minShell) < 0) throw IllegalStateException("this update needs a new app")
        if (!version.matches(Regex("^[0-9A-Za-z.-]{1,32}$"))) throw IllegalStateException("bad version")

        val list = manifest.getJSONArray("files")
        if (list.length() == 0 || list.length() > MAX_FILES) throw IllegalStateException("the list of files is not valid")
        val files = ArrayList<Triple<String, Long, String>>()
        var total = 0L
        for (i in 0 until list.length()) {
          val entry = list.getJSONObject(i)
          val path = safeRelative(entry.getString("path")) ?: throw IllegalStateException("a file name is not valid")
          val size = entry.getLong("size")
          val hash = entry.getString("sha256").lowercase()
          if (size < 0 || size > MAX_FILE_BYTES || !hash.matches(Regex("^[0-9a-f]{64}$"))) throw IllegalStateException("a file entry is not valid")
          total += size
          files.add(Triple(path, size, hash))
        }
        if (total > MAX_TOTAL_BYTES) throw IllegalStateException("the update is too big")
        if (files.none { it.first == "index.html" }) throw IllegalStateException("the update has no index.html")

        val folder = "v$version"
        val rootDir = root(context)
        rootDir.mkdirs()
        staging = File(rootDir, "$folder.partial")
        staging.deleteRecursively()
        staging.mkdirs()
        val stagingPath = staging.canonicalPath

        files.forEachIndexed { index, (path, size, hash) ->
          val target = File(staging, path)
          if (!target.canonicalPath.startsWith(stagingPath + File.separator)) throw IllegalStateException("a file points outside the folder")
          target.parentFile?.mkdirs()
          val url = "$base/api/update/ui/" + path.split('/').joinToString("/") { URLEncoder.encode(it, "UTF-8").replace("+", "%20") }
          val conn = URL(url).openConnection() as HttpURLConnection
          try {
            conn.connectTimeout = 15_000
            conn.readTimeout = 60_000
            if (conn.responseCode != 200) throw IllegalStateException("$path answered ${conn.responseCode}")
            val digest = MessageDigest.getInstance("SHA-256")
            var count = 0L
            FileOutputStream(target).use { output ->
              conn.inputStream.use { input ->
                val buffer = ByteArray(32 * 1024)
                while (true) {
                  val n = input.read(buffer)
                  if (n < 0) break
                  count += n
                  if (count > size) throw IllegalStateException("$path is bigger than it should be")
                  digest.update(buffer, 0, n)
                  output.write(buffer, 0, n)
                }
              }
            }
            if (count != size) throw IllegalStateException("$path has the wrong size")
            val actual = digest.digest().joinToString("") { "%02x".format(it) }
            if (actual != hash) throw IllegalStateException("$path does not match its hash")
          } finally {
            conn.disconnect()
          }
          progress = JSONObject().put("state", "working").put("done", index + 1).put("total", files.size)
        }

        val finalDir = File(rootDir, folder)
        finalDir.deleteRecursively()
        if (!staging.renameTo(finalDir)) throw IllegalStateException("could not put the files in place")
        staging = null
        // older downloaded versions go
        rootDir.listFiles { f -> f.isDirectory && f.name.startsWith("v") && f.name != folder }?.forEach { it.deleteRecursively() }
        // not confirmed yet: if the page never reports in, the next start goes back to the apk's screens
        File(rootDir, "pending").writeText(version)
        val tmp = File(rootDir, "meta.json.tmp")
        tmp.writeText(JSONObject().put("version", version).put("folder", folder).toString())
        if (!tmp.renameTo(File(rootDir, "meta.json"))) {
          File(rootDir, "meta.json").delete()
          tmp.renameTo(File(rootDir, "meta.json"))
        }
        Log.i(TAG, "screens updated to $version (apk ${BuildConfig.VERSION_NAME})")
        progress = JSONObject().put("state", "done").put("version", version)
      } catch (e: Exception) {
        Log.w(TAG, "update failed: ${e.message}")
        progress = JSONObject().put("state", "failed").put("error", e.message ?: "failed")
      } finally {
        try { staging?.deleteRecursively() } catch (e: Exception) { /* left for the next start */ }
        busy.set(false)
      }
    }.start()
    return true
  }
}
