package vn.circlevault.app

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.SharedPreferences
import android.net.Uri
import android.os.Environment
import androidx.core.content.ContextCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        Prefs.init(this)
        Store.init(this)
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CH_DOWNLOAD, "Tải về", NotificationManager.IMPORTANCE_LOW))
        nm.createNotificationChannel(NotificationChannel(CH_DONE, "Tải xong", NotificationManager.IMPORTANCE_DEFAULT))
    }

    companion object {
        const val CH_DOWNLOAD = "tai-ve"
        const val CH_DONE = "tai-xong"
    }
}

/* ------------------------------------------------------------------ cấu hình nhỏ */
object Prefs {
    private lateinit var sp: SharedPreferences
    fun init(c: Context) {
        sp = c.getSharedPreferences("cv", Context.MODE_PRIVATE)
    }

    private fun str(k: String) = sp.getString(k, "") ?: ""
    private fun put(k: String, v: String) = sp.edit().putString(k, v).apply()

    /** http://192.168.1.5:8686 */
    var base: String get() = str("base"); set(v) = put("base", v)
    var token: String get() = str("token"); set(v) = put("token", v)
    var deviceName: String get() = str("device"); set(v) = put("device", v)
    var pcName: String get() = str("pc"); set(v) = put("pc", v)
    var volume: Int get() = sp.getInt("volume", 0); set(v) = sp.edit().putInt("volume", v).apply()
    val paired get() = base.isNotEmpty() && token.isNotEmpty()
}

/* ------------------------------------------------------------------ dữ liệu từ máy tính */
data class RTrack(val id: Int, val title: String, val artist: String?, val duration: Double, val size: Long, val ext: String)
data class RPlaylist(val id: Int, val name: String, val count: Int, val size: Long)
data class RPlaylistDetail(val id: Int, val name: String, val tracks: List<RTrack>)
data class RVideo(
    val id: Int, val title: String, val duration: Double, val height: Int, val size: Long, val ext: String, val thumb: String?,
)

class NotPaired(msg: String) : Exception(msg)

const val OFFLINE_MSG = "Không kết nối được máy tính. Máy tính phải đang bật, mở CircleVault, và điện thoại dùng cùng Wi-Fi."

object Api {
    val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(6, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    fun authed(url: String): Request.Builder = Request.Builder().url(url)
        .header("Cookie", "cv_dev=${Prefs.token}")
        .header("X-CircleVault-App", "1")

    fun detail(body: String?): String? =
        runCatching { JSONObject(body ?: "").optString("detail") }.getOrNull()?.takeIf { it.isNotBlank() }

    private suspend fun get(path: String): String = withContext(Dispatchers.IO) {
        http.newCall(authed(Prefs.base + path).build()).execute().use { r ->
            val body = r.body?.string() ?: ""
            if (r.code == 401) throw NotPaired(detail(body) ?: "Thiết bị chưa được phép.")
            if (!r.isSuccessful) throw IOException(detail(body) ?: "Lỗi ${r.code}")
            body
        }
    }

    /** Ghép thiết bị: trả về (mã bí mật, tên máy tính). */
    suspend fun pair(base: String, code: String, name: String): Pair<String, String> = withContext(Dispatchers.IO) {
        val body = JSONObject().put("code", code).put("name", name).toString()
            .toRequestBody("application/json".toMediaType())
        val req = Request.Builder().url("$base/api/phone/pair").post(body).header("X-CircleVault-App", "1").build()
        http.newCall(req).execute().use { r ->
            val text = r.body?.string() ?: ""
            if (!r.isSuccessful) throw IOException(detail(text) ?: "Lỗi ${r.code}")
            val j = JSONObject(text)
            val token = j.optString("token").ifBlank {
                r.headers("Set-Cookie").firstNotNullOfOrNull { Regex("cv_dev=([^;]+)").find(it)?.groupValues?.get(1) } ?: ""
            }
            if (token.isBlank()) throw IOException("Máy tính chưa cập nhật CircleVault bản mới. Hãy cập nhật rồi thử lại.")
            token to j.optString("server", "Máy tính")
        }
    }

    suspend fun me(): JSONObject = JSONObject(get("https://rp2.alfred511.top/hf/api/phone/me"))

    private fun JSONObject.track() = RTrack(
        getInt("id"), optString("title"), optString("artist").takeIf { it.isNotBlank() && it != "null" },
        optDouble("duration", 0.0).let { if (it.isNaN()) 0.0 else it }, optLong("size"), optString("ext", ".mp3"),
    )

    private inline fun <T> JSONArray.map(f: (JSONObject) -> T): List<T> = (0 until length()).map { f(getJSONObject(it)) }

    suspend fun playlists(): List<RPlaylist> = JSONArray(get("https://rp2.alfred511.top/hf/api/phone/playlists"))
        .map { RPlaylist(it.getInt("id"), it.optString("name"), it.optInt("count"), it.optLong("size")) }

    suspend fun playlist(id: Int): RPlaylistDetail = JSONObject(get("https://rp2.alfred511.top/hf/api/phone/playlists/$id")).let { j ->
        RPlaylistDetail(j.getInt("id"), j.optString("name"), j.getJSONArray("tracks").map { it.track() })
    }

    suspend fun tracks(q: String): List<RTrack> =
        JSONArray(get("https://rp2.alfred511.top/hf/api/phone/tracks?limit=${if (q.isBlank()) 30 else 100}&q=${Uri.encode(q)}")).map { it.track() }

    suspend fun videos(q: String, offset: Int): List<RVideo> =
        JSONArray(get("https://rp2.alfred511.top/hf/api/phone/videos?limit=40&offset=$offset&q=${Uri.encode(q)}")).map {
            RVideo(
                it.getInt("id"), it.optString("title"), it.optDouble("duration", 0.0).let { d -> if (d.isNaN()) 0.0 else d },
                it.optInt("height"), it.optLong("size"), it.optString("ext", ".mp4"),
                it.optString("thumb").takeIf { t -> t.startsWith("http") },
            )
        }

    fun trackFileUrl(id: Int) = "${Prefs.base}/api/phone/track/$id/file"
    fun trackCoverUrl(id: Int) = "${Prefs.base}/api/phone/track/$id/cover"
    fun videoFileUrl(id: Int) = "${Prefs.base}/api/phone/video/$id/file"
}

/* ------------------------------------------------------------------ thư viện trên điện thoại */
data class OTrack(
    val id: Int, val title: String, val artist: String?, val duration: Double, val size: Long, val path: String, val cover: String?,
)

data class OVideo(val id: Int, val title: String, val duration: Double, val size: Long, val path: String, val thumb: String?)
data class OPlaylist(val id: Int, val name: String, val trackIds: List<Int>)
data class Library(
    val tracks: Map<Int, OTrack> = emptyMap(),
    val videos: Map<Int, OVideo> = emptyMap(),
    val playlists: List<OPlaylist> = emptyList(),
) {
    val empty get() = tracks.isEmpty() && videos.isEmpty()
    val bytes get() = tracks.values.sumOf { it.size } + videos.values.sumOf { it.size }
}

/** Nơi lưu: thư mục riêng của app trên bộ nhớ máy hoặc thẻ nhớ (không cần xin quyền; gỡ app thì mất). */
data class Vol(val index: Int, val label: String, val dir: File, val free: Long, val total: Long)

object Store {
    private lateinit var file: File
    private lateinit var ctx: Context
    val lib = MutableStateFlow(Library())

    fun init(c: Context) {
        ctx = c.applicationContext
        file = File(ctx.filesDir, "thu-vien.json")
        val l = load()
        lib.value = l.copy(
            tracks = l.tracks.filterValues { File(it.path).exists() },
            videos = l.videos.filterValues { File(it.path).exists() },
        )
    }

    fun volumes(): List<Vol> = ContextCompat.getExternalFilesDirs(ctx, null).toList().mapIndexedNotNull { i, d ->
        if (d == null || Environment.getExternalStorageState(d) != Environment.MEDIA_MOUNTED) return@mapIndexedNotNull null
        val removable = runCatching { Environment.isExternalStorageRemovable(d) }.getOrDefault(i > 0)
        Vol(i, if (removable) "Thẻ nhớ" else "Bộ nhớ máy", d, d.usableSpace, d.totalSpace)
    }

    fun current(): Vol {
        val v = volumes()
        return v.firstOrNull { it.index == Prefs.volume } ?: v.firstOrNull()
            ?: Vol(0, "Bộ nhớ máy", ctx.filesDir, ctx.filesDir.usableSpace, ctx.filesDir.totalSpace)
    }

    fun baseDir(): File = File(current().dir, "CircleVault").apply { mkdirs() }

    private fun load(): Library = runCatching {
        val j = JSONObject(file.readText())
        val tr = j.optJSONArray("tracks") ?: JSONArray()
        val vd = j.optJSONArray("videos") ?: JSONArray()
        val pl = j.optJSONArray("playlists") ?: JSONArray()
        Library(
            tracks = (0 until tr.length()).map { tr.getJSONObject(it) }.associate {
                it.getInt("id") to OTrack(
                    it.getInt("id"), it.optString("title"), it.optString("artist").takeIf { a -> a.isNotBlank() },
                    it.optDouble("duration", 0.0), it.optLong("size"), it.getString("path"),
                    it.optString("cover").takeIf { c -> c.isNotBlank() },
                )
            },
            videos = (0 until vd.length()).map { vd.getJSONObject(it) }.associate {
                it.getInt("id") to OVideo(
                    it.getInt("id"), it.optString("title"), it.optDouble("duration", 0.0), it.optLong("size"),
                    it.getString("path"), it.optString("thumb").takeIf { c -> c.isNotBlank() },
                )
            },
            playlists = (0 until pl.length()).map { pl.getJSONObject(it) }.map {
                val ids = it.getJSONArray("tracks")
                OPlaylist(it.getInt("id"), it.optString("name"), (0 until ids.length()).map { k -> ids.getInt(k) })
            },
        )
    }.getOrDefault(Library())

    private fun save(l: Library) {
        val j = JSONObject()
        j.put("tracks", JSONArray(l.tracks.values.map {
            JSONObject().put("id", it.id).put("title", it.title).put("artist", it.artist ?: "").put("duration", it.duration)
                .put("size", it.size).put("path", it.path).put("cover", it.cover ?: "")
        }))
        j.put("videos", JSONArray(l.videos.values.map {
            JSONObject().put("id", it.id).put("title", it.title).put("duration", it.duration).put("size", it.size)
                .put("path", it.path).put("thumb", it.thumb ?: "")
        }))
        j.put("playlists", JSONArray(l.playlists.map {
            JSONObject().put("id", it.id).put("name", it.name).put("tracks", JSONArray(it.trackIds))
        }))
        val tmp = File(file.path + ".tmp")
        tmp.writeText(j.toString())
        tmp.renameTo(file)
    }

    @Synchronized
    private fun edit(f: (Library) -> Library) {
        val n = f(lib.value)
        lib.value = n
        save(n)
    }

    private fun delFiles(vararg paths: String?) = paths.filterNotNull().forEach { File(it).delete() }

    fun addTrack(t: OTrack) = edit { it.copy(tracks = it.tracks - t.id + (t.id to t)) }
    fun addVideo(v: OVideo) = edit { it.copy(videos = it.videos - v.id + (v.id to v)) }
    fun savePlaylist(p: OPlaylist) = edit { l -> l.copy(playlists = l.playlists.filterNot { it.id == p.id } + p) }

    fun deleteTrack(id: Int) = edit { l ->
        l.tracks[id]?.let { delFiles(it.path, it.cover) }
        l.copy(tracks = l.tracks - id)
    }

    fun deleteVideo(id: Int) = edit { l ->
        l.videos[id]?.let { delFiles(it.path, it.thumb) }
        l.copy(videos = l.videos - id)
    }

    /** Xóa playlist khỏi điện thoại, kèm các bài không nằm trong playlist nào khác. */
    fun deletePlaylist(id: Int) = edit { l ->
        val p = l.playlists.find { it.id == id } ?: return@edit l
        val others = l.playlists.filter { it.id != id }.flatMap { it.trackIds }.toSet()
        val gone = p.trackIds.filter { it !in others }.toSet()
        gone.forEach { tid -> l.tracks[tid]?.let { delFiles(it.path, it.cover) } }
        l.copy(tracks = l.tracks - gone, playlists = l.playlists.filter { it.id != id })
    }

    fun deleteAll() = edit { l ->
        l.tracks.values.forEach { delFiles(it.path, it.cover) }
        l.videos.values.forEach { delFiles(it.path, it.thumb) }
        volumes().forEach { v -> File(v.dir, "CircleVault").walkBottomUp().filter { it.name.endsWith(".part") }.forEach { it.delete() } }
        Library()
    }
}

fun safeName(s: String): String =
    s.replace(Regex("[\\\\/:*?\"<>|\\x00-\\x1f]+"), " ").replace(Regex("\\s+"), " ").trim(' ', '.').take(90).ifBlank { "khong-ten" }

fun fmtBytes(n: Long): String {
    if (n <= 0) return "0 MB"
    val u = listOf("B", "KB", "MB", "GB", "TB")
    var v = n.toDouble()
    var i = 0
    while (v >= 1024 && i < u.size - 1) {
        v /= 1024; i++
    }
    return if (i >= 3) "%.1f %s".format(v, u[i]) else "%.0f %s".format(v, u[i])
}

fun fmtDur(sec: Double): String {
    val s = sec.toLong()
    if (s <= 0) return ""
    val h = s / 3600
    val m = s % 3600 / 60
    val x = s % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, x) else "%d:%02d".format(m, x)
}
