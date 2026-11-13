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

    /* ---- thêm vào playlist trên điện thoại (nút ＋ Playlist): bài đã có thì thêm ngay, bài online thì lưu về máy rồi thêm */
    data class AddTarget(val title: String, val trackId: Int?, val online: OnlineTrack?)
    var adding by mutableStateOf<AddTarget?>(null)

    fun addCurrentToPlaylist() {
        val ctl = PlayerConn.controller ?: return
        val m = ctl.currentMediaItem ?: return
        val title = m.mediaMetadata.title?.toString() ?: "bài đang nghe"
        val id = m.mediaId
        adding = when {
            id.startsWith("t") -> AddTarget(title, id.drop(1).toIntOrNull(), null)
            id.startsWith("y") -> PlayerConn.currentOnline()?.let { o -> AddTarget(title, Store.byYt(o.yt)?.id, o) }
            id.startsWith("g") -> Store.byGd(id.drop(1))?.let { AddTarget(title, it.id, null) }
            else -> null
        }
        if (adding == null) toast("Bài này chưa lưu về điện thoại – tải về trước rồi thêm vào playlist.")
    }

    fun addToPlaylist(t: AddTarget, pid: Int?, name: String) {
        val id = pid ?: YouTube.playlistIdFor("pl:" + name.trim().lowercase())
        adding = null
        if (t.trackId != null && t.trackId in Store.lib.value.tracks) {
            val pl = Store.lib.value.playlists.find { it.id == id }
            if (pl != null && t.trackId in pl.trackIds) { toast("\"${t.title}\" đã có trong \"$name\"."); return }
            Store.addToPlaylist(id, name, t.trackId)
            toast("Đã thêm vào playlist \"$name\".")
            return
        }
        val o = t.online ?: return
        if (!enoughSpace(6L * 1024 * 1024)) return
        val n = Downloads.enqueue(ctx, listOf(YouTube.saveJob(o, id to name)))
        toast(if (n == 0) "Đang lưu bài này rồi." else "Đang lưu \"${o.title}\" về điện thoại, xong sẽ vào playlist \"$name\". Máy tính cũng được báo để tải vào playlist cùng tên.")
    }

    /* ---- Online: 0 YouTube · 1 Google Drive · 2 Xem chung */
    var onlineSeg by mutableIntStateOf(0)
    var partyUrl by mutableStateOf<String?>(null)

    /** đưa bài trên điện thoại lên Google Drive (tài khoản đang chọn); playlist → thư mục con cùng tên */
    fun uploadDrive(tracks: List<OTrack>, sub: String?) {
        if (Drive.accounts.isEmpty()) {
            toast("Chưa kết nối Google Drive: vào Online → Google Drive → Thêm tài khoản.")
            onlineSeg = 1; tab = 1
            return
        }
        if (Drive.uploading != null) {
            toast("Đang lưu lên Drive, đợi xong đã."); return
        }
        viewModelScope.launch {
            toast("Đang lưu ${tracks.size} bài lên Google Drive (${Drive.active})…")
            try {
                val failed = Drive.upload(ctx, tracks, sub)
                toast(if (failed == 0) "Đã lưu lên Google Drive${sub?.let { " (thư mục \"$it\")" } ?: ""}." else "Xong, $failed bài không lưu được.")
            } catch (e: Drive.NeedConsent) {
                toast("Cần cho phép Google Drive lại: vào Online → Google Drive.")
            } catch (e: Throwable) {
                toast("Không lưu được lên Drive: ${e.message}")
            }
        }
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

    fun downloadTracks(list: List<RTrack>, label: String? = null, update: Boolean = false) {
        val have = Store.lib.value.tracks.keys
        val need = list.filter { it.id !in have }
        if (need.isEmpty()) {
            toast(if (label != null) "\"$label\" đã có đủ trên điện thoại." else "Bài này đã có trên điện thoại."); return
        }
        if (!enoughSpace(need.sumOf { it.size })) return
        val n = Downloads.enqueue(ctx, need.map { Downloads.trackJob(it) })
        val what = if (update) "$n bài mới" else "$n bài"
        toast(if (n == 0) "Đang tải rồi." else "Đang tải $what${label?.let { " của \"$it\"" } ?: ""} (${fmtBytes(need.sumOf { it.size })}). Xem ở tab Điện thoại.")
    }

    /** So playlist trên máy tính với bản trên điện thoại: bài chưa tải (missing), bài máy tính đã bỏ khỏi playlist (removed).
     *  local = null: điện thoại chưa tải playlist này. */
    data class PlSync(val local: OPlaylist?, val missing: Int, val missingBytes: Long, val removed: Int)

    fun plSync(p: RPlaylist, lib: Library): PlSync {
        val local = lib.playlists.find { it.id == p.id } ?: return PlSync(null, p.count, p.size, 0)
        if (p.ids.isEmpty() && p.count > 0) {   // máy tính bản cũ chưa gửi danh sách id: so theo số bài
            val haveN = local.trackIds.count { it > 0 && it in lib.tracks }
            return PlSync(local, maxOf(0, p.count - haveN), 0, 0)
        }
        val miss = p.ids.filter { it !in lib.tracks }
        val avg = if (p.count > 0) p.size / p.count else 0
        val ids = p.ids.toSet()
        return PlSync(local, miss.size, miss.size * avg, local.trackIds.count { it > 0 && it !in ids })
    }

    /** Tải playlist lần đầu hoặc cập nhật: lấy danh sách MỚI từ máy tính, đổi thứ tự/bài theo máy tính
     *  (giữ bài điện thoại tự thêm – id âm), rồi tải các bài còn thiếu. Không xóa file nào. */
    fun downloadPlaylist(p: RPlaylist, quiet: Boolean = false) = viewModelScope.launch {
        try {
            val d = Api.playlist(p.id)
            if (opened.containsKey(p.id)) opened[p.id] = d
            val old = Store.lib.value.playlists.find { it.id == p.id }
            val pcIds = d.tracks.map { it.id }
            val ids = pcIds + (old?.trackIds?.filter { it < 0 && it !in pcIds } ?: emptyList())
            val removed = old?.trackIds?.count { it > 0 && it !in pcIds } ?: 0
            Store.savePlaylist(OPlaylist(d.id, d.name, ids))
            val have = Store.lib.value.tracks.keys
            if (old != null && d.tracks.all { it.id in have }) {
                if (!quiet) toast("\"${d.name}\" đã đủ ${d.tracks.size} bài" + if (removed > 0) " (bỏ $removed bài máy tính đã xóa khỏi playlist)." else ".")
                return@launch
            }
            downloadTracks(d.tracks, d.name, update = old != null)
        } catch (e: Exception) {
            fail(e); toast(remoteErr ?: "Lỗi")
        }
    }

    /** Cập nhật mọi playlist đã tải về điện thoại mà máy tính có bài mới. */
    fun syncAllPlaylists() {
        val lib = Store.lib.value
        val todo = (playlists ?: return).filter { p -> plSync(p, lib).let { it.local != null && (it.missing > 0 || it.removed > 0) } }
        if (todo.isEmpty()) { toast("Các playlist trên điện thoại đã khớp với máy tính."); return }
        todo.forEach { downloadPlaylist(it, quiet = true) }
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
