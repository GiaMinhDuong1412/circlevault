package vn.circlevault.app

import android.content.Context
import android.net.Uri
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import org.schabi.newpipe.extractor.NewPipe
import org.schabi.newpipe.extractor.ServiceList
import org.schabi.newpipe.extractor.downloader.Downloader
import org.schabi.newpipe.extractor.downloader.Request
import org.schabi.newpipe.extractor.downloader.Response
import org.schabi.newpipe.extractor.localization.ContentCountry
import org.schabi.newpipe.extractor.localization.Localization
import org.schabi.newpipe.extractor.playlist.PlaylistInfo
import org.schabi.newpipe.extractor.search.SearchInfo
import org.schabi.newpipe.extractor.services.youtube.YoutubeParsingHelper
import org.schabi.newpipe.extractor.services.youtube.linkHandler.YoutubeSearchQueryHandlerFactory
import org.schabi.newpipe.extractor.stream.DeliveryMethod
import org.schabi.newpipe.extractor.stream.StreamInfo
import org.schabi.newpipe.extractor.stream.StreamInfoItem
import java.util.concurrent.ConcurrentHashMap

/** Một bài trên YouTube (chưa lưu về máy). */
data class OnlineTrack(val yt: String, val title: String, val artist: String?, val duration: Double, val thumb: String?)

/** Danh sách đang mở ở tab Online (playlist của tôi, kết quả tìm kiếm, link). */
data class OnlineList(val key: String, val title: String, val tracks: List<OnlineTrack>, val viaPc: Boolean)

/**
 * Nghe YouTube trên điện thoại.
 * - Máy tính bật + cùng Wi-Fi: đi qua máy tính (dùng tài khoản YouTube đã đăng nhập trên máy tính, xem được playlist riêng tư).
 * - Máy tính tắt: điện thoại tự lấy luồng âm thanh bằng NewPipeExtractor (playlist công khai/không công khai, tìm kiếm).
 * Bài phát online dùng địa chỉ `cvyt://<id>`; Playback.kt đổi thành link thật lúc phát (link YouTube hết hạn sau vài giờ).
 */
object YouTube {
    @Volatile var pcOk = false          // lần gần nhất gọi máy tính thành công

    private var inited = false
    private val resolved = ConcurrentHashMap<String, Pair<Long, Resolved>>()

    data class Resolved(val url: String, val headers: Map<String, String>, val ext: String, val mime: String?)

    @Synchronized
    private fun init() {
        if (inited) return
        NewPipe.init(OkDownloader, Localization("vi", "VN"), ContentCountry("VN"))
        inited = true
    }

    /** NewPipe gọi mạng qua OkHttp của app. */
    private object OkDownloader : Downloader() {
        override fun execute(request: Request): Response {
            val body = request.dataToSend()
            val rb = okhttp3.Request.Builder().url(request.url())
                .method(request.httpMethod(), body?.toRequestBody(null))
            request.headers().forEach { (k, vs) ->
                rb.removeHeader(k)
                vs.forEach { rb.addHeader(k, it) }
            }
            if (request.headers().keys.none { it.equals("User-Agent", true) }) {
                rb.header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0")
            }
            Api.http.newCall(rb.build()).execute().use { r ->
                return Response(r.code, r.message, r.headers.toMultimap(), r.body?.string(), r.request.url.toString())
            }
        }
    }

    fun uriOf(yt: String): Uri = Uri.parse("cvyt://$yt")

    private fun idOf(url: String): String? =
        Regex("(?:v=|youtu\\.be/|shorts/)([\\w-]{11})").find(url)?.groupValues?.get(1)

    private fun StreamInfoItem.toTrack(): OnlineTrack? {
        val id = idOf(url) ?: return null
        return OnlineTrack(
            id, name, uploaderName?.removeSuffix(" - Topic"), duration.toDouble().coerceAtLeast(0.0),
            thumbnails.maxByOrNull { it.height }?.url,
        )
    }

    private fun JSONObject.toTrack(): OnlineTrack? {
        val id = optString("yt").ifBlank { optString("id") }.takeIf { it.length == 11 } ?: return null
        return OnlineTrack(
            id, optString("title", id), optString("artist").takeIf { it.isNotBlank() && it != "null" },
            optDouble("duration", 0.0).let { if (it.isNaN()) 0.0 else it }, optString("thumb").takeIf { it.startsWith("http") },
        )
    }

    private fun JSONObject.toList(viaPc: Boolean): OnlineList {
        val arr = optJSONArray("entries") ?: JSONArray()
        return OnlineList(
            optString("key"), optString("title"),
            (0 until arr.length()).mapNotNull { arr.getJSONObject(it).toTrack() }, viaPc,
        )
    }

    /* ---- playlist của tôi (qua máy tính; nhớ lại để xem được khi máy tính tắt) */
    data class MyList(val id: String, val title: String, val count: Int)

    fun cachedLists(): List<MyList> = runCatching {
        val a = JSONArray(Prefs.ytLists)
        (0 until a.length()).map { a.getJSONObject(it) }.map { MyList(it.getString("id"), it.optString("title"), it.optInt("count")) }
    }.getOrDefault(emptyList())

    /** null = máy tính chưa đăng nhập YouTube */
    suspend fun myLists(): List<MyList>? {
        val j = Api.ytPlaylists()
        pcOk = true
        if (!j.optBoolean("logged_in")) return null
        val items = j.optJSONArray("items") ?: JSONArray()
        val out = (0 until items.length()).map { items.getJSONObject(it) }
            .map { MyList(it.getString("id"), it.optString("title"), it.optInt("count", -1)) }
        Prefs.ytLists = JSONArray(out.map { JSONObject().put("id", it.id).put("title", it.title).put("count", it.count) }).toString()
        return out
    }

    private fun cacheFile(ctx: Context, key: String) = java.io.File(ctx.cacheDir, "yt-list-${key.hashCode()}.json")

    /** mở playlist: qua máy tính nếu được, không thì tự đọc (và dùng bản nhớ lần trước nếu có). */
    suspend fun open(ctx: Context, src: String): OnlineList {
        if (Prefs.paired) {
            try {
                val j = Api.ytList(src)
                pcOk = true
                withContext(Dispatchers.IO) { cacheFile(ctx, src).writeText(j.toString()) }
                return j.toList(true)
            } catch (e: NotPaired) {
                throw e
            } catch (e: Exception) {
                pcOk = false
            }
        }
        val err = try {
            return openDirect(src)
        } catch (e: Throwable) {
            e
        }
        val f = cacheFile(ctx, src)
        if (f.exists()) return JSONObject(f.readText()).toList(false)
        throw IllegalStateException(err.message ?: "Không mở được danh sách này.")
    }

    private suspend fun openDirect(src: String): OnlineList = withContext(Dispatchers.IO) {
        init()
        val url = when {
            src.startsWith("http") -> src
            src.startsWith("v:") -> "https://www.youtube.com/watch?v=${src.drop(2)}"
            src == "LL" || src == "WL" -> throw IllegalStateException("Danh sách này chỉ xem được qua máy tính (cần tài khoản YouTube).")
            else -> "https://www.youtube.com/playlist?list=$src"
        }
        val one = idOf(url)
        if (one != null && !url.contains("list=")) {
            val info = StreamInfo.getInfo(ServiceList.YouTube, url)
            return@withContext OnlineList(
                "v:$one", info.name,
                listOf(OnlineTrack(one, info.name, info.uploaderName, info.duration.toDouble(), info.thumbnails.maxByOrNull { it.height }?.url)),
                false,
            )
        }
        val info = PlaylistInfo.getInfo(ServiceList.YouTube, url)
        val items = info.relatedItems.toMutableList()
        var page = info.nextPage
        while (page != null && items.size < 500) {
            val more = PlaylistInfo.getMoreItems(ServiceList.YouTube, url, page)
            items += more.items
            page = more.nextPage
        }
        OnlineList(src, info.name, items.mapNotNull { it.toTrack() }, false)
    }

    suspend fun search(q: String): OnlineList {
        if (Prefs.paired) {
            try {
                val j = Api.ytSearch(q)
                pcOk = true
                return j.toList(true).copy(title = "Tìm “$q”")
            } catch (e: NotPaired) {
                throw e
            } catch (e: Exception) {
                pcOk = false
            }
        }
        return withContext(Dispatchers.IO) {
            init()
            val yt = ServiceList.YouTube
            val tracks = try {
                SearchInfo.getInfo(yt, yt.searchQHFactory.fromQuery(q, listOf(YoutubeSearchQueryHandlerFactory.MUSIC_SONGS), ""))
                    .relatedItems.filterIsInstance<StreamInfoItem>().mapNotNull { it.toTrack() }
            } catch (e: Exception) {
                emptyList()
            }.ifEmpty {
                SearchInfo.getInfo(yt, yt.searchQHFactory.fromQuery(q, listOf(YoutubeSearchQueryHandlerFactory.VIDEOS), ""))
                    .relatedItems.filterIsInstance<StreamInfoItem>().mapNotNull { it.toTrack() }
            }
            OnlineList("@search", "Tìm “$q”", tracks, false)
        }
    }

    /**
     * Link phát thật cho một bài (chạy ở luồng nền). Qua máy tính nếu đang kết nối được, không thì tự lấy luồng âm thanh.
     * Kết quả tự lấy được nhớ 4 giờ (link YouTube hết hạn sau khoảng 6 giờ).
     */
    fun resolve(yt: String, preferPc: Boolean = pcOk): Resolved {
        if (preferPc && Prefs.paired) {
            return Resolved(Api.ytStreamUrl(yt), mapOf("Cookie" to "cv_dev=${Prefs.token}", "X-CircleVault-App" to "1"), "", null)
        }
        resolved[yt]?.let { (at, r) -> if (System.currentTimeMillis() - at < 4 * 3600_000L) return r }
        init()
        val info = StreamInfo.getInfo(ServiceList.YouTube, "https://www.youtube.com/watch?v=$yt")
        val best = info.audioStreams
            .filter { it.isUrl && it.deliveryMethod == DeliveryMethod.PROGRESSIVE_HTTP }
            .sortedWith(compareByDescending<org.schabi.newpipe.extractor.stream.AudioStream> { it.format?.suffix == "m4a" }
                .thenByDescending { it.averageBitrate })
            .firstOrNull() ?: throw IllegalStateException("Bài này không có luồng âm thanh phát được.")
        val url = best.content
        val ua = when {
            YoutubeParsingHelper.isVisionOsStreamingUrl(url) -> YoutubeParsingHelper.getVisionOsUserAgent(null)
            else -> "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0"
        }
        val headers = mutableMapOf("User-Agent" to ua)
        if (YoutubeParsingHelper.isWebStreamingUrl(url)) {
            headers["Origin"] = "https://www.youtube.com"; headers["Referer"] = "https://www.youtube.com/"
        }
        val r = Resolved(url, headers, best.format?.suffix ?: "m4a", best.format?.mimeType)
        resolved[yt] = System.currentTimeMillis() to r
        return r
    }

    /* ---- lưu bài YouTube về điện thoại + báo máy tính */
    fun saveJob(t: OnlineTrack, playlist: Pair<Int, String>?): DJob = DJob(
        key = "y${t.yt}", title = t.title, url = "", dest = "", total = 0, online = t, onlinePlaylist = playlist,
        coverUrl = t.thumb, coverAuth = false,
    )

    fun playlistIdFor(key: String) = -(1_000_000 + Math.floorMod(key.hashCode(), 1_000_000_000))

    @Synchronized
    fun queueReport(t: OnlineTrack, playlist: String?) {
        val a = runCatching { JSONArray(Prefs.syncQueue) }.getOrDefault(JSONArray())
        a.put(JSONObject().put("yt", t.yt).put("title", t.title).put("artist", t.artist ?: "").put("playlist", playlist ?: ""))
        Prefs.syncQueue = a.toString()
    }

    /** gửi hàng chờ lên máy tính (khi kết nối được); máy tính sẽ hỏi có tải về không */
    suspend fun flushReports() {
        if (!Prefs.paired) return
        val a = runCatching { JSONArray(Prefs.syncQueue) }.getOrDefault(JSONArray())
        if (a.length() == 0) return
        runCatching { Api.reportSaved(a) }.onSuccess { Prefs.syncQueue = "[]" }
    }
}

