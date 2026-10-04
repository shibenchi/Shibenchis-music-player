package com.shibenchi.musicplayer

import android.content.Context
import android.util.Log
import com.yausername.youtubedl_android.YoutubeDL
import com.yausername.youtubedl_android.YoutubeDLRequest
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.OutputStream
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URL
import java.net.URLDecoder
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

// the phone version of the local audio helper. the desktop app starts a node
// process that answers six endpoints on 127.0.0.1:3002 and uses yt-dlp to talk
// to youtube. there is no node on a phone, so this does the same thing from
// inside the app: a tiny http server on the same port with the same endpoints
// and the same answers, so the interface does not know the difference. yt-dlp
// comes from the youtubedl-android library, which bundles it with python.
class MediaHelper private constructor(private val context: Context) {
  companion object {
    private const val TAG = "SmpHelper"
    private const val PORT = 3002
    private const val AUDIO_FORMAT = "bestaudio[ext=m4a]/bestaudio/best"

    // the part of a track youtube's own api link will serve without extra tokens
    private const val FAST_LIMIT = 1_048_576L
    private const val RESOLVED_URL_TTL_MS = 3L * 60 * 60 * 1000
    private const val SEARCH_TTL_MS = 5L * 60 * 1000
    private const val UPDATE_EVERY_MS = 12L * 60 * 60 * 1000
    private val VIDEO_ID = Regex("^[A-Za-z0-9_-]{6,20}$")
    private val LIST_ID = Regex("^[A-Za-z0-9_-]{2,80}$")
    private val BOT_CHECK = Regex(
      "confirm you.?re not a bot|sign in to confirm|http error 429|too many requests|unusual traffic",
      RegexOption.IGNORE_CASE
    )

    private val started = AtomicBoolean(false)

    fun start(context: Context) {
      if (!started.compareAndSet(false, true)) return
      MediaHelper(context.applicationContext).begin()
    }
  }

  private class Request(
    val method: String,
    val path: String,
    val query: Map<String, String>,
    val headers: Map<String, String>
  )

  private class Resolved(val url: String, val headers: Map<String, String>, val expiresAt: Long, val size: Long = -1L)

  private class Failure(val status: Int, message: String, val code: String? = null) : Exception(message)

  private val pool = Executors.newCachedThreadPool()
  private val ready = CountDownLatch(1)
  @Volatile private var initError: String? = null

  // yt-dlp is a python process, a phone should not run a dozen of them at once
  private val gate = Semaphore(3)

  private val resolvedUrls = ConcurrentHashMap<String, Resolved>()
  private val resolving = ConcurrentHashMap<String, CompletableFuture<Resolved>>()
  private val downloading = ConcurrentHashMap<String, CompletableFuture<File>>()
  private val searches = ConcurrentHashMap<String, Pair<Long, JSONArray>>()

  // while youtube is rate limiting this phone, background work (prefetch) backs off
  @Volatile private var cooldownUntil = 0L
  @Volatile private var cooldownMs = 0L

  private val cacheDir: File by lazy { File(context.filesDir, "audio_cache").also { it.mkdirs() } }

  // songs saved for offline listening. kept apart from the stream cache because
  // the cache is trimmed when it grows, these stay until they are removed
  private val offlineDir: File by lazy { File(context.filesDir, "offline").also { it.mkdirs() } }

  // the port is opened right here, before the interface has had a chance to
  // ask for anything. an interface that asked a moment too early used to be told
  // "no helper" and kept that answer for fifteen seconds
  private fun begin() {
    val server = openPort()
    Thread({ trimCache(400L * 1024 * 1024) }, "smp-cache-trim").start()
    Thread({ initYtDlp() }, "smp-ytdlp-init").start()
    if (server != null) Thread({ acceptLoop(server) }, "smp-helper-server").start()
  }

  // what the interface can show while things start: "starting", "updating" (a
  // new yt-dlp is being fetched), "ready" or "error"
  @Volatile private var ytdlpState = "starting"

  // search and audio links go straight to youtube and do not need yt-dlp, so
  // this only matters for the fallback. first launch unpacks python and yt-dlp,
  // which takes a few seconds, and the update below then runs behind everything
  private fun initYtDlp() {
    try {
      YoutubeDL.getInstance().init(context)
      ytdlpState = "ready"
    } catch (e: Throwable) {
      initError = e.message ?: e.toString()
      ytdlpState = "error"
      Log.e(TAG, "yt-dlp failed to start", e)
    } finally {
      ready.countDown()
    }
    if (initError == null) refreshYtDlpIfDue()
  }

  // youtube changes often and an old yt-dlp stops working, so it updates itself
  // at most twice a day. nothing else is running yt-dlp while the files are
  // replaced, and a slow network gives up after 20 seconds
  private fun refreshYtDlpIfDue() {
    val prefs = context.getSharedPreferences("smp_helper", Context.MODE_PRIVATE)
    val last = prefs.getLong("ytdlp_updated_at", 0L)
    if (System.currentTimeMillis() - last < UPDATE_EVERY_MS) return
    gate.acquire(3)
    ytdlpState = "updating"
    try {
      val update = pool.submit<String> {
        val status = YoutubeDL.getInstance().updateYoutubeDL(context, YoutubeDL.UpdateChannel.STABLE)
        prefs.edit().putLong("ytdlp_updated_at", System.currentTimeMillis()).apply()
        status?.toString() ?: "unknown"
      }
      Log.i(TAG, "yt-dlp update: ${update.get(20, TimeUnit.SECONDS)}")
    } catch (e: Exception) {
      Log.i(TAG, "yt-dlp update skipped: ${e.message}")
    } finally {
      ytdlpState = "ready"
      gate.release(3)
    }
  }

  private fun awaitReady() {
    if (!ready.await(90, TimeUnit.SECONDS)) throw Failure(503, "audio helper is still starting")
    initError?.let { throw Failure(500, "audio helper could not start: $it") }
  }

  // ---------------------------------------------------------------- server

  // downloaded tracks pile up, so when the folder grows past the limit the ones
  // used longest ago are deleted
  private fun trimCache(limitBytes: Long) {
    try {
      val files = cacheDir.listFiles()?.filter { it.isFile }?.sortedBy { it.lastModified() } ?: return
      var size = files.sumOf { it.length() }
      for (f in files) {
        if (size <= limitBytes) break
        size -= f.length()
        f.delete()
      }
    } catch (e: Exception) {
      Log.i(TAG, "cache trim skipped: ${e.message}")
    }
  }

  private fun openPort(): ServerSocket? {
    return try {
      ServerSocket(PORT, 50, InetAddress.getByName("127.0.0.1")).also {
        Log.i(TAG, "audio helper listening on 127.0.0.1:$PORT")
      }
    } catch (e: IOException) {
      Log.e(TAG, "could not open port $PORT", e)
      null
    }
  }

  private fun acceptLoop(server: ServerSocket) {
    while (true) {
      val socket = try { server.accept() } catch (e: IOException) { break }
      pool.execute { handle(socket) }
    }
  }

  private fun handle(socket: Socket) {
    socket.use { s ->
      s.soTimeout = 0
      val out = s.getOutputStream().buffered(32 * 1024)
      val req = try { readRequest(s) } catch (e: Exception) { null } ?: return
      try {
        route(req, out)
      } catch (e: Failure) {
        sendError(req, out, e)
      } catch (e: IOException) {
        // the player moved on to another track and closed the connection
      } catch (e: Exception) {
        Log.w(TAG, "${req.path} failed", e)
        try { sendError(req, out, Failure(500, e.message ?: "helper error")) } catch (_: IOException) {}
      }
      try { out.flush() } catch (_: IOException) {}
    }
  }

  private fun readRequest(socket: Socket): Request? {
    val input = socket.getInputStream().bufferedReader(Charsets.ISO_8859_1)
    val first = input.readLine() ?: return null
    val parts = first.split(' ')
    if (parts.size < 2) return null
    val headers = HashMap<String, String>()
    for (i in 0 until 100) {
      val line = input.readLine() ?: break
      if (line.isEmpty()) break
      val colon = line.indexOf(':')
      if (colon > 0) headers[line.substring(0, colon).trim().lowercase()] = line.substring(colon + 1).trim()
    }
    val target = parts[1]
    val q = target.indexOf('?')
    val path = if (q >= 0) target.substring(0, q) else target
    val query = HashMap<String, String>()
    if (q >= 0) {
      target.substring(q + 1).split('&').forEach { pair ->
        if (pair.isEmpty()) return@forEach
        val eq = pair.indexOf('=')
        val key = if (eq >= 0) pair.substring(0, eq) else pair
        val value = if (eq >= 0) pair.substring(eq + 1) else ""
        query[URLDecoder.decode(key, "UTF-8")] = URLDecoder.decode(value, "UTF-8")
      }
    }
    return Request(parts[0].uppercase(), path, query, headers)
  }

  private fun corsHeaders(req: Request): Map<String, String> {
    val origin = req.headers["origin"]
    val map = LinkedHashMap<String, String>()
    map["Access-Control-Allow-Origin"] = origin ?: "*"
    if (origin != null) {
      map["Access-Control-Allow-Credentials"] = "true"
      map["Vary"] = "Origin"
    }
    map["Access-Control-Allow-Headers"] = "Content-Type, Range"
    map["Access-Control-Allow-Methods"] = "GET, OPTIONS"
    map["Access-Control-Allow-Private-Network"] = "true"
    map["Access-Control-Expose-Headers"] = "Content-Length, Content-Range, Accept-Ranges"
    return map
  }

  private fun reason(status: Int) = when (status) {
    200 -> "OK"; 204 -> "No Content"; 206 -> "Partial Content"; 400 -> "Bad Request"
    403 -> "Forbidden"; 404 -> "Not Found"; 405 -> "Method Not Allowed"; 416 -> "Range Not Satisfiable"
    500 -> "Internal Server Error"; 501 -> "Not Implemented"; 503 -> "Service Unavailable"
    else -> "OK"
  }

  private fun writeHead(out: OutputStream, req: Request, status: Int, headers: Map<String, String>) {
    val sb = StringBuilder("HTTP/1.1 $status ${reason(status)}\r\n")
    corsHeaders(req).forEach { (k, v) -> sb.append(k).append(": ").append(v).append("\r\n") }
    headers.forEach { (k, v) -> sb.append(k).append(": ").append(v).append("\r\n") }
    sb.append("Connection: close\r\n\r\n")
    out.write(sb.toString().toByteArray(Charsets.ISO_8859_1))
  }

  private fun sendJson(req: Request, out: OutputStream, status: Int, body: JSONObject, extra: Map<String, String> = emptyMap()) {
    val bytes = body.toString().toByteArray(Charsets.UTF_8)
    writeHead(out, req, status, extra + mapOf("Content-Type" to "application/json; charset=utf-8", "Content-Length" to bytes.size.toString()))
    out.write(bytes)
    out.flush()
  }

  private fun sendError(req: Request, out: OutputStream, failure: Failure) {
    val body = JSONObject().put("error", failure.message ?: "helper error")
    failure.code?.let { body.put("code", it) }
    val extra = if (failure.code == "youtube_bot_check") mapOf("Retry-After" to "60") else emptyMap()
    sendJson(req, out, failure.status, body, extra)
  }

  private fun route(req: Request, out: OutputStream) {
    if (req.method == "OPTIONS") {
      writeHead(out, req, 204, mapOf("Content-Length" to "0"))
      return
    }
    if (req.method != "GET" && req.method != "HEAD") throw Failure(405, "method not allowed")
    when (req.path) {
      "/api/version" -> sendJson(req, out, 200, JSONObject().put("version", "local-helper").put("mode", "helper"))
      "/api/status" -> sendJson(req, out, 200, JSONObject().put("ready", true).put("direct", true).put("ytdlp", ytdlpState))
      "/api/search" -> apiSearch(req, out)
      "/api/playlist" -> apiPlaylist(req, out)
      "/api/info" -> apiInfo(req, out)
      "/api/prefetch" -> apiPrefetch(req, out)
      "/api/stream" -> apiStream(req, out)
      "/api/download" -> apiDownload(req, out)
      "/api/offline/list" -> apiOfflineList(req, out)
      "/api/offline/save" -> apiOfflineSave(req, out)
      "/api/offline/remove" -> apiOfflineRemove(req, out)
      "/api/debug/ytdlp" -> if (BuildConfig.DEBUG) apiDebug(req, out) else throw Failure(404, "not found")
      "/api/debug/client" -> if (BuildConfig.DEBUG) apiDebugClient(req, out) else throw Failure(404, "not found")
      "/api/debug/full" -> if (BuildConfig.DEBUG) apiDebugFull(req, out) else throw Failure(404, "not found")
      else -> throw Failure(404, "not found")
    }
  }

  // --------------------------------------------------------------- yt-dlp

  // recent yt-dlp needs a javascript runtime to read some youtube videos, and
  // the library ships QuickJS for that. an older yt-dlp does not know the
  // option and would refuse to run, so it is only passed once the version is new
  // enough (the runtime support arrived in 2025.11.12)
  private val jsRuntime: Pair<String, String>? by lazy {
    val qjs = File(context.applicationInfo.nativeLibraryDir, "libqjs.so")
    val version = YoutubeDL.version(context) ?: ""
    if (qjs.exists() && version >= "2025.11.12") "--js-runtimes" to "quickjs:${qjs.absolutePath}" else null
  }

  // runs yt-dlp and returns what it printed. options are plain strings, or a
  // pair when the option takes a value
  private fun ytdlp(url: String, vararg options: Any): String {
    awaitReady()
    gate.acquire()
    try {
      val request = YoutubeDLRequest(url)
      jsRuntime?.let { request.addOption(it.first, it.second) }
      for (option in options) {
        if (option is Pair<*, *>) request.addOption(option.first as String, option.second as String)
        else request.addOption(option as String)
      }
      return YoutubeDL.getInstance().execute(request).out
    } catch (e: Exception) {
      throw asFailure(e)
    } finally {
      gate.release()
    }
  }

  // yt-dlp reports problems as one long stderr dump. the useful part is the
  // last "ERROR:" line, and the bot check gets its own code like on desktop
  private fun asFailure(e: Throwable): Failure {
    if (e is Failure) return e
    val raw = e.message ?: e.toString()
    if (BOT_CHECK.containsMatchIn(raw)) {
      noteBotCheck()
      return Failure(503, "YouTube is asking for a sign-in check right now. Wait a few minutes and try again.", "youtube_bot_check")
    }
    val line = raw.lines().lastOrNull { it.contains("ERROR:") } ?: raw.lines().lastOrNull { it.isNotBlank() } ?: raw
    return Failure(500, line.removePrefix("ERROR:").trim().take(300))
  }

  // one piece of slow work per key, shared by everyone who asks for it while it
  // runs (a prefetch and the real play of the same track, for example)
  private fun <T> shared(map: ConcurrentHashMap<String, CompletableFuture<T>>, key: String, work: () -> T): T {
    val mine = CompletableFuture<T>()
    val existing = map.putIfAbsent(key, mine)
    if (existing == null) {
      pool.execute {
        try { mine.complete(work()) } catch (t: Throwable) { mine.completeExceptionally(t) } finally { map.remove(key) }
      }
    }
    try {
      return (existing ?: mine).get()
    } catch (e: ExecutionException) {
      throw asFailure(e.cause ?: e)
    }
  }

  private fun noteBotCheck() {
    cooldownMs = if (cooldownMs == 0L) 60_000L else minOf(cooldownMs * 2, 10 * 60_000L)
    cooldownUntil = System.currentTimeMillis() + cooldownMs
  }

  private fun noteYoutubeOk() {
    cooldownMs = 0L
    cooldownUntil = 0L
  }

  private fun inCooldown() = System.currentTimeMillis() < cooldownUntil

  private fun parseJson(raw: String): JSONObject {
    val line = raw.lines().lastOrNull { it.trimStart().startsWith("{") } ?: throw Failure(500, "yt-dlp returned nothing readable")
    return JSONObject(line)
  }

  private fun videoIdOf(req: Request): String {
    val id = req.query["videoId"]?.trim().orEmpty()
    if (id.isEmpty()) throw Failure(400, "Missing videoId query parameter")
    if (!VIDEO_ID.matches(id)) throw Failure(400, "Invalid videoId")
    return id
  }

  private fun watchUrl(id: String) = "https://www.youtube.com/watch?v=$id"

  // --------------------------------------------------- search / playlist / info

  private fun entriesToResults(entries: JSONArray?, limit: Int): JSONArray {
    val results = JSONArray()
    if (entries == null) return results
    for (i in 0 until entries.length()) {
      if (results.length() >= limit) break
      val e = entries.optJSONObject(i) ?: continue
      val id = e.optString("id")
      val title = e.optString("title")
      if (id.isEmpty() || title.isEmpty()) continue
      results.put(
        JSONObject()
          .put("videoId", id)
          .put("title", title)
          .put("author", e.optString("channel").ifEmpty { e.optString("uploader") })
          .put("duration", e.optInt("duration", 0))
          .put("thumbnail", "https://i.ytimg.com/vi/$id/hqdefault.jpg")
      )
    }
    return results
  }

  private fun apiSearch(req: Request, out: OutputStream) {
    val query = req.query["q"]?.trim().orEmpty()
    if (query.isEmpty()) throw Failure(400, "Missing query parameter")

    val cached = searches[query]
    if (cached != null && System.currentTimeMillis() - cached.first < SEARCH_TTL_MS) {
      sendJson(req, out, 200, JSONObject().put("query", query).put("results", cached.second))
      return
    }
    val results = try {
      YouTubeDirect.search(query, 20).also { if (it.length() == 0) throw IOException("no results") }
    } catch (direct: Exception) {
      Log.i(TAG, "direct search failed (${direct.message}), using yt-dlp")
      val raw = ytdlp("ytsearch20:$query", "--dump-single-json", "--flat-playlist", "--no-warnings")
      entriesToResults(parseJson(raw).optJSONArray("entries"), 20)
    }
    noteYoutubeOk()
    if (results.length() > 0) searches[query] = System.currentTimeMillis() to results
    sendJson(req, out, 200, JSONObject().put("query", query).put("results", results))
  }

  private fun apiPlaylist(req: Request, out: OutputStream) {
    val id = (req.query["list"] ?: req.query["playlistId"] ?: "").trim()
    if (id.isEmpty()) throw Failure(400, "Missing playlist ID")
    if (!LIST_ID.matches(id)) throw Failure(400, "Invalid playlist ID")
    val raw = ytdlp("https://www.youtube.com/playlist?list=$id", "--dump-single-json", "--flat-playlist", "--no-warnings")
    val info = parseJson(raw)
    val items = JSONArray()
    val entries = info.optJSONArray("entries")
    if (entries != null) {
      for (i in 0 until entries.length()) {
        val e = entries.optJSONObject(i) ?: continue
        val vid = e.optString("id")
        if (vid.isEmpty()) continue
        items.put(
          JSONObject()
            .put("videoId", vid)
            .put("title", e.optString("title").ifEmpty { "Track $vid" })
            .put("author", e.optString("uploader").ifEmpty { e.optString("uploader_id") })
        )
      }
    }
    noteYoutubeOk()
    sendJson(req, out, 200, JSONObject().put("playlistId", id).put("title", info.optString("title").ifEmpty { "Playlist ${id.takeLast(6)}" }).put("items", items))
  }

  private fun apiInfo(req: Request, out: OutputStream) {
    val id = videoIdOf(req)
    val direct = try { YouTubeDirect.audio(id) } catch (e: Exception) { null }
    if (direct != null && direct.title.isNotEmpty()) {
      noteYoutubeOk()
      sendJson(req, out, 200, JSONObject().put("videoId", id).put("title", direct.title).put("author", direct.author))
      return
    }
    val info = parseJson(ytdlp(watchUrl(id), "--dump-single-json", "--no-warnings", "--no-playlist", "--skip-download"))
    noteYoutubeOk()
    sendJson(req, out, 200, JSONObject().put("videoId", id).put("title", info.optString("title")).put("author", info.optString("uploader").ifEmpty { info.optString("channel") }))
  }

  // ------------------------------------------------------- stream / prefetch

  // the slow part of starting a track is yt-dlp working out the direct audio
  // url. results are kept for a while, and a prefetch for the next track
  // shares the same lookup if the track is started before it finishes
  private fun resolveDirectUrl(videoId: String): Resolved {
    resolvedUrls[videoId]?.let { if (it.expiresAt > System.currentTimeMillis()) return it }
    val resolved = shared(resolving, videoId) {
      try {
        val audio = YouTubeDirect.audio(videoId)
        noteYoutubeOk()
        // the link says how long it lives, stop using it a few minutes before that
        val ttl = minOf(RESOLVED_URL_TTL_MS, audio.expiresInSec * 1000 - 5 * 60_000).coerceAtLeast(60_000)
        Resolved(audio.url, mapOf("User-Agent" to audio.userAgent), System.currentTimeMillis() + ttl, audio.size)
      } catch (direct: Exception) {
        Log.i(TAG, "direct audio lookup failed for $videoId (${direct.message}), using yt-dlp")
        resolveWithYtDlp(videoId)
      }
    }
    resolvedUrls[videoId] = resolved
    return resolved
  }

  // the link yt-dlp finds takes five seconds or so, but unlike the quick one it
  // serves the whole file, so it carries a track past its first minute
  private fun resolveWithYtDlp(videoId: String): Resolved {
    val info = parseJson(
      ytdlp(watchUrl(videoId), "--dump-single-json", "--no-warnings", "--no-playlist", "--skip-download", "-f" to AUDIO_FORMAT)
    )
    val url = info.optString("url")
    if (url.isEmpty()) throw Failure(500, "no direct stream url resolved")
    val headers = HashMap<String, String>()
    info.optJSONObject("http_headers")?.let { h -> h.keys().forEach { k -> headers[k] = h.optString(k) } }
    noteYoutubeOk()
    return Resolved(url, headers, System.currentTimeMillis() + RESOLVED_URL_TTL_MS)
  }

  private val fullLinks = ConcurrentHashMap<String, Resolved>()
  private val resolvingFull = ConcurrentHashMap<String, CompletableFuture<Resolved>>()

  private fun resolveFullLink(videoId: String): Resolved {
    fullLinks[videoId]?.let { if (it.expiresAt > System.currentTimeMillis()) return it }
    val resolved = shared(resolvingFull, videoId) { resolveWithYtDlp(videoId) }
    fullLinks[videoId] = resolved
    return resolved
  }

  // the link itself misbehaved (refused, cut off), as opposed to the player
  // closing its end. the stream can try again with a fresh link
  private class LinkTrouble(message: String) : IOException(message)

  private fun apiPrefetch(req: Request, out: OutputStream) {
    val id = videoIdOf(req)
    if (inCooldown()) {
      sendJson(req, out, 200, JSONObject().put("ok", false).put("error", "paused while youtube is rate limiting").put("code", "youtube_bot_check"))
      return
    }
    try {
      resolveDirectUrl(id)
      sendJson(req, out, 200, JSONObject().put("ok", true))
    } catch (e: Failure) {
      // not fatal, the stream request just resolves again when the track plays
      sendJson(req, out, 200, JSONObject().put("ok", false).put("error", e.message))
    }
  }

  private fun apiStream(req: Request, out: OutputStream) {
    val id = videoIdOf(req)
    val saved = File(offlineDir, "$id.m4a")
    if (isCompleteAudioFile(saved)) {
      serveFile(req, out, saved, "audio/m4a")
      return
    }
    val cached = File(cacheDir, "$id.m4a")
    if (cached.exists()) {
      if (isCompleteAudioFile(cached)) {
        serveFile(req, out, cached, "audio/m4a")
        return
      }
      cached.delete()
    }

    try {
      val resolved = resolveDirectUrl(id)
      try {
        proxy(req, out, resolved, id)
        return
      } catch (e: UpstreamFailure) {
        // the cached url stopped working, resolve again below
        resolvedUrls.remove(id)
        throw e
      }
    } catch (fast: Exception) {
      if (fast is IOException && fast !is UpstreamFailure) throw fast
      val failure = asFailure(fast)
      if (failure.code == "youtube_bot_check") throw failure
      Log.i(TAG, "stream fast path failed for $id (${failure.message}), downloading instead")
      val file = downloadToCache(id)
      serveFile(req, out, file, "audio/m4a")
    }
  }

  private class UpstreamFailure(message: String) : IOException(message)

  // the direct url is fetched here and passed on, not redirected to. keeping it
  // on this origin matters because the equalizer and visualizer silence a media
  // element that comes from somewhere else
  private fun proxy(req: Request, out: OutputStream, resolved: Resolved, videoId: String) {
    // links from youtube's own api only answer requests for a bounded range, and
    // the player asks for "from here to the end", so those are served in chunks
    if (resolved.size > 0) {
      proxyChunked(req, out, resolved, videoId)
      return
    }
    val conn = URL(resolved.url).openConnection() as HttpURLConnection
    try {
      conn.connectTimeout = 15_000
      conn.readTimeout = 25_000
      conn.instanceFollowRedirects = true
      resolved.headers["User-Agent"]?.let { conn.setRequestProperty("User-Agent", it) }
      req.headers["range"]?.let { conn.setRequestProperty("Range", it) }
      val code = try { conn.responseCode } catch (e: IOException) { throw UpstreamFailure(e.message ?: "upstream unreachable") }
      if (code !in 200..299) throw UpstreamFailure("upstream answered $code")

      val head = LinkedHashMap<String, String>()
      head["Content-Type"] = conn.contentType ?: "audio/mp4"
      conn.getHeaderField("Content-Length")?.let { head["Content-Length"] = it }
      conn.getHeaderField("Content-Range")?.let { head["Content-Range"] = it }
      head["Accept-Ranges"] = "bytes"
      writeHead(out, req, code, head)
      if (req.method == "HEAD") return

      val buffer = ByteArray(32 * 1024)
      conn.inputStream.use { input ->
        while (true) {
          val n = input.read(buffer)
          if (n < 0) break
          out.write(buffer, 0, n)
          out.flush()
        }
      }
    } finally {
      conn.disconnect()
    }
  }

  // one request from the player. youtube's own api gives a link that only serves
  // the first mebibyte of the file (about a minute of music) without extra
  // tokens, so playback starts from that at once while yt-dlp fetches the whole
  // file in the background. the first piece comes from the link, whatever is
  // past it from the finished file. the two are the same bytes (checked on
  // several tracks: same size, same first mebibyte), so the player just sees
  // one long answer. a track that is shorter than the piece comes from the link
  // alone
  private fun proxyChunked(req: Request, out: OutputStream, resolved: Resolved, videoId: String) {
    val total = resolved.size
    var start = 0L
    var end = total - 1
    var status = 200
    val match = Regex("^bytes=(\\d*)-(\\d*)$").find(req.headers["range"]?.trim().orEmpty())
    if (match != null && (match.groupValues[1].isNotEmpty() || match.groupValues[2].isNotEmpty())) {
      if (match.groupValues[1].isEmpty()) {
        start = maxOf(0L, total - match.groupValues[2].toLong())
      } else {
        start = match.groupValues[1].toLong()
        if (match.groupValues[2].isNotEmpty()) end = minOf(match.groupValues[2].toLong(), total - 1)
      }
      if (start >= total || start > end) {
        writeHead(out, req, 416, mapOf("Content-Range" to "bytes */$total", "Content-Length" to "0"))
        return
      }
      status = 206
    }

    val directEnd = if (total > FAST_LIMIT) FAST_LIMIT - 1 else total - 1
    if (total > FAST_LIMIT && start <= directEnd) {
      // the rest of the file is needed within a minute, so find the link for it now
      pool.execute { try { resolveFullLink(videoId) } catch (e: Exception) { Log.i(TAG, "full link lookup failed: ${e.message}") } }
    }

    var position = start
    var headSent = false
    val buffer = ByteArray(32 * 1024)

    fun sendHead() {
      if (headSent) return
      val head = LinkedHashMap<String, String>()
      head["Content-Type"] = "audio/mp4"
      head["Accept-Ranges"] = "bytes"
      head["Content-Length"] = (end - start + 1).toString()
      if (status == 206) head["Content-Range"] = "bytes $start-$end/$total"
      writeHead(out, req, status, head)
      headSent = true
    }
    // before anything is sent a failure can still become the fallback, after it
    // the stream can only be cut
    fun failure(message: String): IOException = if (headSent) IOException(message) else UpstreamFailure(message)

    // copies from a link to the player, moving position forward as it goes
    fun pump(url: String, userAgent: String?, from: Long, to: Long) {
      val conn = URL(url).openConnection() as HttpURLConnection
      try {
        conn.connectTimeout = 15_000
        conn.readTimeout = 25_000
        conn.instanceFollowRedirects = true
        userAgent?.let { conn.setRequestProperty("User-Agent", it) }
        conn.setRequestProperty("Range", "bytes=$from-$to")
        val code = try { conn.responseCode } catch (e: IOException) { throw LinkTrouble(e.message ?: "link unreachable") }
        if (code != 206 && !(code == 200 && from == 0L)) throw LinkTrouble("link answered $code")
        sendHead()
        if (req.method == "HEAD") {
          position = end + 1
          return
        }
        conn.inputStream.use { input ->
          while (true) {
            val n = try { input.read(buffer) } catch (e: IOException) { throw LinkTrouble(e.message ?: "link cut off") }
            if (n < 0) break
            out.write(buffer, 0, n)
            out.flush()
            position += n
          }
        }
      } finally {
        conn.disconnect()
      }
    }

    while (position <= end) {
      if (position <= directEnd) {
        val pieceEnd = minOf(position + (if (!headSent) 128 * 1024 else 512 * 1024) - 1, end, directEnd)
        val conn = URL(resolved.url).openConnection() as HttpURLConnection
        try {
          conn.connectTimeout = 15_000
          conn.readTimeout = 25_000
          conn.instanceFollowRedirects = true
          resolved.headers["User-Agent"]?.let { conn.setRequestProperty("User-Agent", it) }
          conn.setRequestProperty("Range", "bytes=$position-$pieceEnd")
          val code = try { conn.responseCode } catch (e: IOException) { throw failure(e.message ?: "upstream unreachable") }
          if (code != 206 && code != 200) throw failure("upstream answered $code")
          sendHead()
          if (req.method == "HEAD") return
          conn.inputStream.use { input ->
            while (true) {
              val n = input.read(buffer)
              if (n < 0) break
              out.write(buffer, 0, n)
              out.flush()
            }
          }
        } finally {
          conn.disconnect()
        }
        position = pieceEnd + 1
      } else {
        // past the first piece: the rest comes from the full link while the
        // listener is still playing what was already sent. a link that fails is
        // looked up again, and only after that does the stream give up
        var attempts = 0
        while (position <= end) {
          try {
            val full = resolveFullLink(videoId)
            val before = position
            pump(full.url, full.headers["User-Agent"], position, end)
            // a link that answers but sends nothing would loop forever otherwise
            if (position == before && position <= end) throw LinkTrouble("the link sent no data")
          } catch (e: LinkTrouble) {
            fullLinks.remove(videoId)
            attempts++
            Log.i(TAG, "full link trouble for $videoId at $position: ${e.message}")
            if (attempts >= 3) throw failure(e.message ?: "the audio link kept failing")
          } catch (e: Failure) {
            attempts++
            if (attempts >= 2) throw failure(e.message ?: "no full audio link")
          }
        }
      }
    }
  }

  private fun isCompleteAudioFile(file: File): Boolean {
    if (!file.exists() || file.length() < 10_000) return false
    return try {
      file.inputStream().use { input ->
        val head = ByteArray(12)
        val read = input.read(head)
        read == 12 && String(head, 4, 4, Charsets.ISO_8859_1) == "ftyp"
      }
    } catch (e: IOException) {
      false
    }
  }

  private fun serveFile(req: Request, out: OutputStream, file: File, contentType: String) {
    val size = file.length()
    var start = 0L
    var end = size - 1
    var status = 200
    val match = Regex("^bytes=(\\d*)-(\\d*)$").find(req.headers["range"]?.trim().orEmpty())
    if (match != null && (match.groupValues[1].isNotEmpty() || match.groupValues[2].isNotEmpty())) {
      if (match.groupValues[1].isEmpty()) {
        start = maxOf(0L, size - match.groupValues[2].toLong())
      } else {
        start = match.groupValues[1].toLong()
        if (match.groupValues[2].isNotEmpty()) end = minOf(match.groupValues[2].toLong(), size - 1)
      }
      if (start >= size || start > end) {
        writeHead(out, req, 416, mapOf("Content-Range" to "bytes */$size", "Content-Length" to "0"))
        return
      }
      status = 206
    }
    val head = LinkedHashMap<String, String>()
    head["Accept-Ranges"] = "bytes"
    head["Content-Type"] = contentType
    head["Content-Length"] = (end - start + 1).toString()
    if (status == 206) head["Content-Range"] = "bytes $start-$end/$size"
    writeHead(out, req, status, head)
    if (req.method == "HEAD") return

    RandomAccessFile(file, "r").use { raf ->
      raf.seek(start)
      val buffer = ByteArray(64 * 1024)
      var left = end - start + 1
      while (left > 0) {
        val n = raf.read(buffer, 0, minOf(buffer.size.toLong(), left).toInt())
        if (n < 0) break
        out.write(buffer, 0, n)
        left -= n
      }
    }
  }

  // downloads the audio under a throwaway name and moves it into the cache only
  // once it is whole, so a half written file is never served
  private fun downloadToCache(videoId: String): File {
    val target = File(cacheDir, "$videoId.m4a")
    if (isCompleteAudioFile(target)) return target
    return shared(downloading, videoId) {
      val prefix = "$videoId.dl-${System.currentTimeMillis()}"
      try {
        val made = File(cacheDir, "$prefix.m4a")
        // fetching the file in several pieces at once is a few times faster
        // than yt-dlp's single connection, which youtube holds to a slow pace.
        // yt-dlp's own download stays as the fallback
        try {
          downloadInPieces(videoId, made)
        } catch (fast: Exception) {
          Log.i(TAG, "piecewise download failed for $videoId (${fast.message}), using yt-dlp")
          made.delete()
          ytdlp(
            watchUrl(videoId), "--no-warnings", "--no-playlist", "--quiet",
            "-f" to AUDIO_FORMAT,
            "-o" to File(cacheDir, "$prefix.%(ext)s").absolutePath
          )
        }
        if (!isCompleteAudioFile(made)) throw Failure(500, "downloaded audio file is incomplete")
        if (!target.exists()) made.renameTo(target)
        noteYoutubeOk()
        target
      } finally {
        cacheDir.listFiles { f -> f.name.startsWith(prefix) }?.forEach { it.delete() }
      }
    }
  }

  // downloads a whole track from the yt-dlp link as several bounded requests at
  // once, each written to its place in the file
  private fun downloadInPieces(videoId: String, work: File) {
    val startedAt = System.currentTimeMillis()
    val link = resolveFullLink(videoId)
    val linkAt = System.currentTimeMillis()
    val pieceSize = 1024L * 1024

    // one bounded request, returns the bytes and the size of the whole file
    fun fetch(from: Long, to: Long): Pair<ByteArray, Long> {
      val conn = URL(link.url).openConnection() as HttpURLConnection
      try {
        conn.connectTimeout = 15_000
        conn.readTimeout = 25_000
        conn.instanceFollowRedirects = true
        link.headers["User-Agent"]?.let { conn.setRequestProperty("User-Agent", it) }
        conn.setRequestProperty("Range", "bytes=$from-$to")
        val code = conn.responseCode
        if (code != 206) throw IOException("link answered $code")
        val total = conn.getHeaderField("Content-Range")?.substringAfter('/')?.toLongOrNull() ?: throw IOException("no size from the link")
        return conn.inputStream.use { it.readBytes() } to total
      } finally {
        conn.disconnect()
      }
    }

    val (first, total) = fetch(0, pieceSize - 1)
    RandomAccessFile(work, "rw").use { raf ->
      raf.setLength(total)
      raf.seek(0)
      raf.write(first)
      val workers = Executors.newFixedThreadPool(4)
      try {
        val jobs = ArrayList<java.util.concurrent.Future<*>>()
        var offset = pieceSize
        while (offset < total) {
          val from = offset
          val to = minOf(from + pieceSize - 1, total - 1)
          jobs.add(workers.submit {
            var attempt = 0
            while (true) {
              try {
                val (bytes, _) = fetch(from, to)
                synchronized(raf) {
                  raf.seek(from)
                  raf.write(bytes)
                }
                break
              } catch (e: IOException) {
                if (++attempt >= 3) throw e
              }
            }
          })
          offset += pieceSize
        }
        for (job in jobs) {
          try { job.get() } catch (e: ExecutionException) { throw e.cause ?: e }
        }
      } finally {
        workers.shutdownNow()
      }
    }
    Log.i(TAG, "piecewise download of $videoId: ${work.length()} bytes, link in ${linkAt - startedAt} ms, pieces in ${System.currentTimeMillis() - linkAt} ms")
  }

  // ---------------------------------------------------------------- offline

  private fun apiOfflineList(req: Request, out: OutputStream) {
    val files = offlineDir.listFiles { f -> f.isFile && f.name.endsWith(".m4a") && isCompleteAudioFile(f) } ?: emptyArray()
    val ids = JSONArray()
    var bytes = 0L
    for (f in files) {
      ids.put(f.name.removeSuffix(".m4a"))
      bytes += f.length()
    }
    sendJson(req, out, 200, JSONObject().put("ids", ids).put("bytes", bytes))
  }

  // downloads one song into the offline folder. takes as long as the download does
  private fun apiOfflineSave(req: Request, out: OutputStream) {
    val id = videoIdOf(req)
    val target = File(offlineDir, "$id.m4a")
    if (!isCompleteAudioFile(target)) {
      val downloaded = downloadToCache(id)
      // moved, not copied, so the song is not stored twice
      if (!downloaded.renameTo(target)) {
        downloaded.copyTo(target, overwrite = true)
        downloaded.delete()
      }
    }
    sendJson(req, out, 200, JSONObject().put("ok", true).put("size", target.length()))
  }

  private fun apiOfflineRemove(req: Request, out: OutputStream) {
    val id = videoIdOf(req)
    File(offlineDir, "$id.m4a").delete()
    sendJson(req, out, 200, JSONObject().put("ok", true))
  }

  // debug builds only: which byte ranges does the yt-dlp (full file) link accept
  private fun apiDebugFull(req: Request, out: OutputStream) {
    val id = videoIdOf(req)
    val body = JSONObject()
    try {
      val link = resolveFullLink(id)
      val head = JSONArray()
      link.headers.forEach { (k, v) -> head.put("$k: ${v.take(60)}") }
      body.put("headers", head)
      body.put("url_params", Regex("[?&]([a-z0-9_]+)=").findAll(link.url).map { it.groupValues[1] }.joinToString(","))
      val probes = JSONArray()
      for (range in listOf("0-1048575", "1048576-2097151", "1048576-", "0-", "2000000-2999999", "3000000-3500000", "0-262143", "100-4000")) {
        val conn = URL(link.url).openConnection() as HttpURLConnection
        try {
          conn.connectTimeout = 8_000
          conn.readTimeout = 15_000
          link.headers["User-Agent"]?.let { conn.setRequestProperty("User-Agent", it) }
          conn.setRequestProperty("Range", "bytes=$range")
          val code = conn.responseCode
          var read = 0L
          if (code in 200..299) {
            val buf = ByteArray(32 * 1024)
            conn.inputStream.use { input -> while (read < 400_000) { val n = input.read(buf); if (n < 0) break; read += n } }
          }
          probes.put("$range -> $code, read $read, content-range ${conn.getHeaderField("Content-Range")}")
        } catch (e: Exception) {
          probes.put("$range -> ${e.message}")
        } finally {
          conn.disconnect()
        }
      }
      body.put("probes", probes)
    } catch (e: Exception) {
      body.put("error", e.message)
    }
    sendJson(req, out, 200, body)
  }

  // debug builds only: asks youtube for audio as one named client and tries a
  // few byte ranges on the link, to see which identity gets unthrottled audio
  private fun apiDebugClient(req: Request, out: OutputStream) {
    val id = videoIdOf(req)
    val name = req.query["client"] ?: "IOS"
    val body = JSONObject().put("client", name)
    try {
      val audio = YouTubeDirect.audio(id, name)
      body.put("size", audio.size)
      val probes = JSONArray()
      val ranges = listOf(0L to 262143L, 262144L to 2359295L, 2000000L to 2099999L, 0L to 2097151L, (audio.size - 100000) to (audio.size - 1))
      for ((a, b) in ranges) {
        val conn = URL(audio.url).openConnection() as HttpURLConnection
        try {
          conn.connectTimeout = 8_000
          conn.readTimeout = 12_000
          conn.setRequestProperty("User-Agent", audio.userAgent)
          conn.setRequestProperty("Range", "bytes=$a-$b")
          val code = conn.responseCode
          var read = 0L
          if (code in 200..299) {
            val buf = ByteArray(32 * 1024)
            conn.inputStream.use { input -> while (true) { val n = input.read(buf); if (n < 0) break; read += n } }
          }
          probes.put("$a-$b -> $code, $read bytes")
        } catch (e: Exception) {
          probes.put("$a-$b -> ${e.message}")
        } finally {
          conn.disconnect()
        }
      }
      body.put("probes", probes)
    } catch (e: Exception) {
      body.put("error", e.message)
    }
    sendJson(req, out, 200, body)
  }

  // debug builds only: runs yt-dlp with the options given as a json array, so a
  // format or client setting can be tried on the phone without a rebuild
  private fun apiDebug(req: Request, out: OutputStream) {
    val args = JSONArray(req.query["args"] ?: "[]")
    if (args.length() == 0) throw Failure(400, "args must be a json array, url first")
    val options = (1 until args.length()).map { args.getString(it) }.toTypedArray<Any>()
    val body = JSONObject().put("ytdlpVersion", YoutubeDL.version(context) ?: "unknown")
    try {
      body.put("out", ytdlp(args.getString(0), *options).take(200_000))
    } catch (e: Failure) {
      body.put("error", e.message)
    }
    sendJson(req, out, 200, body)
  }

  // ---------------------------------------------------------------- download

  // the desktop app converts to mp3, ogg, flac or wav with ffmpeg. that is not
  // bundled here yet, so only the original m4a audio can be handed over
  private fun apiDownload(req: Request, out: OutputStream) {
    val id = videoIdOf(req)
    val format = (req.query["format"] ?: "m4a").trim().lowercase()
    if (format != "m4a") throw Failure(501, "Converting to $format is not available on the phone yet, use m4a")
    val file = downloadToCache(id)
    val name = (req.query["title"] ?: "audio").replace(Regex("[<>:\"/\\\\|?*\\u0000-\\u001F]"), "").replace(Regex("\\s+"), "_").take(200).ifEmpty { "audio" }
    val size = file.length()
    writeHead(out, req, 200, mapOf(
      "Content-Type" to "audio/mp4",
      "Content-Disposition" to "attachment; filename=\"$name.m4a\"",
      "Content-Length" to size.toString(),
      "Accept-Ranges" to "bytes"
    ))
    if (req.method == "HEAD") return
    file.inputStream().use { it.copyTo(out, 64 * 1024) }
  }
}
