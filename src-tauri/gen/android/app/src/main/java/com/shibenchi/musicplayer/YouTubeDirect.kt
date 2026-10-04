package com.shibenchi.musicplayer

import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

// talks to youtube's own app api directly, the same requests its apps make. one
// https request gets a search or an audio link back in well under a second,
// where yt-dlp has to start python first and takes five or six seconds. these
// endpoints are not a public api and change now and then, so every caller keeps
// yt-dlp as the fallback when anything here fails
object YouTubeDirect {
  private const val BASE = "https://www.youtube.com/youtubei/v1"
  private const val WEB_VERSION = "2.20250925.01.00"

  class Audio(val url: String, val userAgent: String, val expiresInSec: Long, val title: String, val author: String, val size: Long)

  private class Client(val name: String, val context: JSONObject, val userAgent: String)

  // the ios app client hands out plain audio links without any extra tokens, the
  // vr client is a second chance for when it stops doing that
  private val clients = listOf(
    Client(
      "IOS",
      JSONObject()
        .put("clientName", "IOS").put("clientVersion", "20.10.4")
        .put("deviceMake", "Apple").put("deviceModel", "iPhone16,2")
        .put("osName", "iPhone").put("osVersion", "18.3.2.22D82")
        .put("hl", "en").put("gl", "US"),
      "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)"
    ),
    Client(
      "ANDROID_MUSIC",
      JSONObject()
        .put("clientName", "ANDROID_MUSIC").put("clientVersion", "7.27.52")
        .put("androidSdkVersion", 30).put("osName", "Android").put("osVersion", "11")
        .put("hl", "en").put("gl", "US"),
      "com.google.android.apps.youtube.music/7.27.52 (Linux; U; Android 11) gzip"
    ),
    Client(
      "ANDROID",
      JSONObject()
        .put("clientName", "ANDROID").put("clientVersion", "19.44.38")
        .put("androidSdkVersion", 30).put("osName", "Android").put("osVersion", "11")
        .put("hl", "en").put("gl", "US"),
      "com.google.android.youtube/19.44.38 (Linux; U; Android 11) gzip"
    ),
    Client(
      "ANDROID_VR",
      JSONObject()
        .put("clientName", "ANDROID_VR").put("clientVersion", "1.60.19")
        .put("deviceMake", "Oculus").put("deviceModel", "Quest 3")
        .put("androidSdkVersion", 32).put("osName", "Android").put("osVersion", "12L")
        .put("hl", "en").put("gl", "US"),
      "com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip"
    )
  )

  private fun postJson(path: String, body: JSONObject, userAgent: String): JSONObject {
    val conn = URL("$BASE/$path?prettyPrint=false").openConnection() as HttpURLConnection
    try {
      conn.requestMethod = "POST"
      conn.doOutput = true
      conn.connectTimeout = 6_000
      conn.readTimeout = 8_000
      conn.setRequestProperty("Content-Type", "application/json")
      conn.setRequestProperty("User-Agent", userAgent)
      conn.setRequestProperty("Accept-Language", "en-US,en;q=0.9")
      conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
      val code = conn.responseCode
      val stream = if (code in 200..299) conn.inputStream else conn.errorStream
      val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
      if (code !in 200..299) throw IOException("youtube answered $code")
      return JSONObject(text)
    } finally {
      conn.disconnect()
    }
  }

  private fun runsText(node: JSONObject?): String {
    if (node == null) return ""
    node.optString("simpleText").takeIf { it.isNotEmpty() }?.let { return it }
    val runs = node.optJSONArray("runs") ?: return ""
    val sb = StringBuilder()
    for (i in 0 until runs.length()) sb.append(runs.optJSONObject(i)?.optString("text").orEmpty())
    return sb.toString()
  }

  // "5:22" or "1:02:03" to seconds
  private fun clockToSeconds(text: String): Int {
    if (text.isEmpty()) return 0
    return text.split(':').fold(0) { total, part -> total * 60 + (part.toIntOrNull() ?: 0) }
  }

  fun search(query: String, limit: Int): JSONArray {
    val body = JSONObject()
      .put("context", JSONObject().put("client", JSONObject().put("clientName", "WEB").put("clientVersion", WEB_VERSION).put("hl", "en").put("gl", "US")))
      .put("query", query)
      .put("params", "EgIQAQ%3D%3D") // videos only
    val json = postJson("search", body, "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36")
    val sections = json.optJSONObject("contents")
      ?.optJSONObject("twoColumnSearchResultsRenderer")
      ?.optJSONObject("primaryContents")
      ?.optJSONObject("sectionListRenderer")
      ?.optJSONArray("contents") ?: throw IOException("unexpected search response")

    val results = JSONArray()
    for (s in 0 until sections.length()) {
      val items = sections.optJSONObject(s)?.optJSONObject("itemSectionRenderer")?.optJSONArray("contents") ?: continue
      for (i in 0 until items.length()) {
        if (results.length() >= limit) return results
        val v = items.optJSONObject(i)?.optJSONObject("videoRenderer") ?: continue
        val id = v.optString("videoId")
        val title = runsText(v.optJSONObject("title"))
        val length = runsText(v.optJSONObject("lengthText"))
        // no length means a live stream or an upcoming premiere, nothing to play
        if (id.isEmpty() || title.isEmpty() || length.isEmpty()) continue
        results.put(
          JSONObject()
            .put("videoId", id)
            .put("title", title)
            .put("author", runsText(v.optJSONObject("ownerText")))
            .put("duration", clockToSeconds(length))
            .put("thumbnail", "https://i.ytimg.com/vi/$id/hqdefault.jpg")
        )
      }
    }
    return results
  }

  // the best audio-only link for a video. mp4 audio first (the player and the
  // offline files both want m4a), then whatever audio there is
  fun audio(videoId: String, only: String? = null): Audio {
    var lastProblem = "no audio found"
    for (client in clients) {
      if (only != null && client.name != only) continue
      try {
        val body = JSONObject()
          .put("context", JSONObject().put("client", client.context))
          .put("videoId", videoId)
          .put("contentCheckOk", true)
          .put("racyCheckOk", true)
        val json = postJson("player", body, client.userAgent)
        val status = json.optJSONObject("playabilityStatus")?.optString("status").orEmpty()
        if (status != "OK") {
          lastProblem = "${client.name}: $status"
          continue
        }
        val formats = json.optJSONObject("streamingData")?.optJSONArray("adaptiveFormats")
        var best: JSONObject? = null
        var bestIsMp4 = false
        if (formats != null) {
          for (i in 0 until formats.length()) {
            val f = formats.optJSONObject(i) ?: continue
            val mime = f.optString("mimeType")
            if (!mime.startsWith("audio/") || f.optString("url").isEmpty()) continue
            val isMp4 = mime.startsWith("audio/mp4")
            val better = best == null ||
              (isMp4 && !bestIsMp4) ||
              (isMp4 == bestIsMp4 && f.optInt("bitrate") > best.optInt("bitrate"))
            if (better) { best = f; bestIsMp4 = isMp4 }
          }
        }
        if (best == null) {
          lastProblem = "${client.name}: no direct audio link"
          continue
        }
        val details = json.optJSONObject("videoDetails")
        return Audio(
          url = best.optString("url"),
          userAgent = client.userAgent,
          expiresInSec = json.optJSONObject("streamingData")?.optString("expiresInSeconds")?.toLongOrNull() ?: 3600L,
          title = details?.optString("title").orEmpty(),
          author = details?.optString("author").orEmpty(),
          size = best.optString("contentLength").toLongOrNull() ?: -1L
        )
      } catch (e: IOException) {
        lastProblem = "${client.name}: ${e.message}"
      }
    }
    throw IOException(lastProblem)
  }
}
