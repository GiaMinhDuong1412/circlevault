package vn.circlevault.app

import android.app.Application
import android.net.Uri
import android.os.Build
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.launch
import java.io.IOException

class MainVM(app: Application) : AndroidViewModel(app) {
    var paired by mutableStateOf(Prefs.paired)
    var pairing by mutableStateOf(false)
    /** 0 Thư viện · 1 Online · 2 Máy tính · 3 Cài đặt */
    var tab by mutableIntStateOf(if (Prefs.paired && Store.lib.value.empty) 2 else 0)
    var remoteKind by mutableIntStateOf(0)

    var playlists by mutableStateOf<List<RPlaylist>?>(null)
    var remoteErr by mutableStateOf<String?>(null)
    var revoked by mutableStateOf(false)
    var loading by mutableStateOf(false)
    val opened = mutableStateMapOf<Int, RPlaylistDetail?>()
    var trackQ by mutableStateOf("")
    var trackRes by mutableStateOf<List<RTrack>>(emptyList())
    var videoQ by mutableStateOf("")
    var videos by mutableStateOf<List<RVideo>?>(null)
    var videosMore by mutableStateOf(false)
    var pcName by mutableStateOf(Prefs.pcName)

    var playingVideo by mutableStateOf<OVideo?>(null)
    var nowPlaying by mutableStateOf(false)
    val toasts = MutableSharedFlow<String>(extraBufferCapacity = 8)

    private val ctx get() = getApplication<Application>()

    fun toast(s: String) {
        toasts.tryEmit(s)
    }

    private fun fail(e: Throwable) {
        when (e) {
            is NotPaired -> {
                revoked = true; remoteErr = e.message
            }
            is java.net.ConnectException, is java.net.SocketTimeoutException, is java.net.UnknownHostException,
            is java.net.NoRouteToHostException, is java.net.SocketException -> remoteErr = OFFLINE_MSG
            else -> remoteErr = e.message ?: OFFLINE_MSG
        }
    }

    init {
        if (paired) refresh()
    }

    fun refresh() = viewModelScope.launch {
        loading = true
        try {
            val me = Api.me()
            if (!me.optBoolean("paired")) throw NotPaired("Thiết bị này đã bị thu hồi trên máy tính.")
            pcName = me.optString("server", pcName).also { Prefs.pcName = it }
            playlists = Api.playlists()
            trackRes = Api.tracks(trackQ)
            opened.keys.toList().forEach { id -> opened[id] = runCatching { Api.playlist(id) }.getOrNull() }
            if (remoteKind == 1 || videos != null) loadVideos(true)
            remoteErr = null
            revoked = false
            YouTube.pcOk = true
            YouTube.flushReports()
        } catch (e: Exception) {
            YouTube.pcOk = false
            fail(e)
        } finally {
            loading = false
        }
    }

    /* ---- tab Online (YouTube) */
    var myLists by mutableStateOf(YouTube.cachedLists())
    var ytLogged by mutableStateOf<Boolean?>(null)
    var onlineList by mutableStateOf<OnlineList?>(null)
    var onlineErr by mutableStateOf<String?>(null)
    var onlineBusy by mutableStateOf(false)
    var onlineQ by mutableStateOf("")

    fun loadMyLists() = viewModelScope.launch {
        if (!Prefs.paired) return@launch
        try {
            val l = YouTube.myLists()
            ytLogged = l != null
            if (l != null) myLists = l
        } catch (e: Throwable) {
            YouTube.pcOk = false
        }
    }

    private fun netMsg(e: Throwable, what: String): String = when {
        e is java.net.UnknownHostException || e.cause is java.net.UnknownHostException ->
            "Không vào được YouTube: điện thoại chưa có Internet."
        e is java.net.SocketTimeoutException -> "YouTube phản hồi quá chậm, thử lại sau."
        else -> "$what: ${e.message ?: "lỗi"}"
    }

    fun openOnline(src: String) = viewModelScope.launch {
        onlineBusy = true
        onlineErr = null
        try {
            onlineList = YouTube.open(ctx, src)
        } catch (e: Throwable) {
            onlineErr = netMsg(e, "Không mở được")
        } finally {
            onlineBusy = false
        }
    }

    fun searchOnline() = viewModelScope.launch {
        val q = onlineQ.trim()
        if (q.isEmpty()) return@launch
        if (q.contains("youtu")) return@launch openOnline(q).let { }
        onlineBusy = true
        onlineErr = null
        try {
            onlineList = YouTube.search(q)
        } catch (e: Throwable) {
            onlineErr = netMsg(e, "Không tìm được")
        } finally {
            onlineBusy = false
        }
    }

    /** lưu bài YouTube về điện thoại (và báo máy tính để hỏi có tải về ổ HDD không) */
    fun saveOnline(tracks: List<OnlineTrack>, list: OnlineList?) {
        val need = tracks.filter { Store.byYt(it.yt) == null }
        if (need.isEmpty()) {
            toast("Đã có trên điện thoại."); return
        }
        val pl = list?.takeIf { it.key != "@search" && !it.key.startsWith("v:") }?.let { YouTube.playlistIdFor(it.key) to it.title }
        if (!enoughSpace(need.size * 6L * 1024 * 1024)) return
        val n = Downloads.enqueue(ctx, need.map { YouTube.saveJob(it, pl) })
        toast(if (n == 0) "Đang lưu rồi." else "Đang lưu $n bài về điện thoại${pl?.let { " (playlist \"${it.second}\")" } ?: ""}.")
    }

    /* ---- chọn bài để ghép, cắt */
    var selecting by mutableStateOf(listOf<Int>())
    var cutting by mutableStateOf<OTrack?>(null)
    var merging by mutableStateOf(false)

    fun toggleSelect(id: Int) {
        selecting = if (id in selecting) selecting - id else selecting + id
    }

    fun searchTracks() = viewModelScope.launch {
        try {
            trackRes = Api.tracks(trackQ)
        } catch (e: Exception) {
            fail(e)
        }
    }

    fun loadVideos(reset: Boolean) = viewModelScope.launch {
        try {
            val cur = if (reset) emptyList() else videos.orEmpty()
            val more = Api.videos(videoQ, cur.size)
            videos = cur + more
            videosMore = more.size >= 30
            remoteErr = null
        } catch (e: Exception) {
            fail(e)
        }
    }

    fun toggle(id: Int) {
        if (opened.containsKey(id)) {
            opened.remove(id); return
        }
        opened[id] = null
        viewModelScope.launch {
            try {
                opened[id] = Api.playlist(id)
            } catch (e: Exception) {
                opened.remove(id); fail(e)
            }
        }
    }

    /* ---- tải về */
    private fun enoughSpace(bytes: Long): Boolean {
        val v = Store.current()
        if (bytes > v.free - 200L * 1024 * 1024) {
            toast("Không đủ chỗ trên ${v.label}: cần ${fmtBytes(bytes)}, còn trống ${fmtBytes(v.free)}. Xóa bớt hoặc đổi nơi lưu ở Cài đặt.")
            return false
        }
        return true
    }

    fun downloadTracks(list: List<RTrack>, label: String? = null) {
        val have = Store.lib.value.tracks.keys
        val need = list.filter { it.id !in have }
        if (need.isEmpty()) {
            toast(if (label != null) "\"$label\" đã có đủ trên điện thoại." else "Bài này đã có trên điện thoại."); return
        }
        if (!enoughSpace(need.sumOf { it.size })) return
        val n = Downloads.enqueue(ctx, need.map { Downloads.trackJob(it) })
        toast(if (n == 0) "Đang tải rồi." else "Đang tải $n bài${label?.let { " của \"$it\"" } ?: ""} (${fmtBytes(need.sumOf { it.size })}). Xem ở tab Điện thoại.")
    }

    fun downloadPlaylist(p: RPlaylist) = viewModelScope.launch {
        try {
            val d = opened[p.id] ?: Api.playlist(p.id)
            Store.savePlaylist(OPlaylist(d.id, d.name, d.tracks.map { it.id }))
            downloadTracks(d.tracks, d.name)
        } catch (e: Exception) {
            fail(e); toast(remoteErr ?: "Lỗi")
        }
    }

    fun downloadVideo(v: RVideo) {
        if (v.id in Store.lib.value.videos) {
            toast("Video này đã có trên điện thoại."); return
        }
        if (!enoughSpace(v.size)) return
        Downloads.enqueue(ctx, listOf(Downloads.videoJob(v)))
        toast("Đang tải \"${v.title}\" (${fmtBytes(v.size)}).")
    }

    /* ---- ghép thiết bị */
    fun pair(base: String, code: String, name: String) {
        if (pairing) return
        pairing = true
        viewModelScope.launch {
            try {
                val (token, server) = Api.pair(base, code.trim().uppercase(), name.trim().ifBlank { defaultName() })
                Prefs.base = base
                Prefs.token = token
                Prefs.deviceName = name.trim()
                Prefs.pcName = server
                pcName = server
                paired = true
                revoked = false
                remoteErr = null
                tab = 2
                toast("Đã kết nối với $server.")
                refresh()
            } catch (e: IOException) {
                toast(
                    if (e is java.net.ConnectException || e is java.net.SocketTimeoutException || e is java.net.NoRouteToHostException) OFFLINE_MSG
                    else e.message ?: "Không ghép được",
                )
            } catch (e: Exception) {
                toast(e.message ?: "Không ghép được")
            } finally {
                pairing = false
            }
        }
    }

    fun unpair() {
        Downloads.cancelAll()
        Prefs.token = ""
        paired = false
        playlists = null
        videos = null
        opened.clear()
        remoteErr = null
        revoked = false
    }

    companion object {
        fun defaultName(): String {
            val m = Build.MODEL ?: ""
            val b = (Build.MANUFACTURER ?: "").replaceFirstChar { it.uppercase() }
            return (if (m.startsWith(b, ignoreCase = true)) m else "$b $m").trim().ifBlank { "Điện thoại" }.take(40)
        }

        /** Mã QR trên máy tính: http://192.168.1.5:8686/dt?pair=ABCD2345 → (http://192.168.1.5:8686, ABCD2345) */
        fun parsePair(raw: String): Pair<String, String>? {
            val u = runCatching { Uri.parse(raw.trim()) }.getOrNull() ?: return null
            val code = u.getQueryParameter("pair") ?: return null
            val host = u.host ?: return null
            return "${u.scheme ?: "http"}://$host${if (u.port > 0) ":${u.port}" else ""}" to code
        }

        /** "192.168.1.5" / "192.168.1.5:8686" / "http://…/dt" → http://192.168.1.5:8686 */
        fun normalizeAddr(s: String): String? {
            val t = s.trim().let { if (it.contains("://")) it else "http://$it" }
            val u = runCatching { Uri.parse(t) }.getOrNull() ?: return null
            val host = u.host?.takeIf { it.isNotBlank() } ?: return null
            return "${u.scheme}://$host:${if (u.port > 0) u.port else 8686}"
        }
    }
}
