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
    var tab by mutableIntStateOf(if (Store.lib.value.empty) 0 else 1)
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
        } catch (e: Exception) {
            fail(e)
        } finally {
            loading = false
        }
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
                tab = 0
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
