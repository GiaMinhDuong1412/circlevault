package vn.circlevault.app

import android.Manifest
import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import okhttp3.Request
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.util.concurrent.TimeUnit

enum class JState { QUEUED, RUNNING, DONE, ERROR }

data class DJob(
    val key: String,
    val title: String,
    val url: String,
    val dest: String,
    val total: Long,
    val done: Long = 0,
    val state: JState = JState.QUEUED,
    val error: String? = null,
    val track: RTrack? = null,
    val video: RVideo? = null,
    val coverUrl: String? = null,
    val coverAuth: Boolean = true,
    val online: OnlineTrack? = null,                 // bài YouTube: link thật lấy lúc tải
    val onlinePlaylist: Pair<Int, String>? = null,   // lưu vào playlist này trên điện thoại
    val drive: Pair<String, String>? = null,         // (email, id file) – tải từ Google Drive
)

/** Hàng đợi tải: lần lượt từng file, tải dở thì lần sau tải tiếp (Range) từ file .part. */
object Downloads {
    val jobs = MutableStateFlow<List<DJob>>(emptyList())
    val active = MutableStateFlow(false)
    private val cancelled = mutableSetOf<String>()
    private val lock = Any()

    fun trackJob(t: RTrack): DJob {
        val dest = File(File(Store.baseDir(), "nhac"), "${t.id} - ${safeName(t.title)}${t.ext}")
        return DJob("t${t.id}", t.title, Api.trackFileUrl(t.id), dest.path, t.size, track = t, coverUrl = Api.trackCoverUrl(t.id))
    }

    fun videoJob(v: RVideo): DJob {
        val dest = File(File(Store.baseDir(), "phim"), "${v.id} - ${safeName(v.title)}${v.ext}")
        return DJob("v${v.id}", v.title, Api.videoFileUrl(v.id), dest.path, v.size, video = v, coverUrl = v.thumb, coverAuth = false)
    }

    /** Thêm vào hàng đợi; trả về số file mới thêm. */
    fun enqueue(ctx: Context, list: List<DJob>): Int {
        var start = false
        val added: Int
        synchronized(lock) {
            val busy = jobs.value.filter { it.state == JState.QUEUED || it.state == JState.RUNNING }.map { it.key }.toSet()
            val add = list.filter { it.key !in busy }.distinctBy { it.key }
            val addKeys = add.map { it.key }.toSet()
            cancelled.removeAll(addKeys)
            jobs.value = jobs.value.filterNot { it.key in addKeys } + add.map { it.copy(state = JState.QUEUED, error = null) }
            added = add.size
            if (jobs.value.any { it.state == JState.QUEUED } && !active.value) {
                active.value = true
                start = true
            }
        }
        if (start) ContextCompat.startForegroundService(ctx, Intent(ctx, DownloadService::class.java))
        return added
    }

    fun resume(ctx: Context) = enqueue(ctx, emptyList())

    fun retry(ctx: Context, key: String) {
        jobs.value.find { it.key == key }?.let { enqueue(ctx, listOf(it)) }
    }

    fun next(): DJob? = synchronized(lock) {
        val j = jobs.value.firstOrNull { it.state == JState.QUEUED }
        if (j == null) active.value = false else update(j.key) { it.copy(state = JState.RUNNING) }
        j
    }

    fun update(key: String, f: (DJob) -> DJob) = synchronized(lock) {
        jobs.value = jobs.value.map { if (it.key == key) f(it) else it }
    }

    fun cancel(key: String) = synchronized(lock) {
        val j = jobs.value.find { it.key == key } ?: return@synchronized
        cancelled += key
        jobs.value = jobs.value.filterNot { it.key == key }
        if (j.state != JState.RUNNING) File(j.dest + ".part").delete()   // đang tải thì dịch vụ tự xóa
    }

    fun cancelAll() = jobs.value.filter { it.state == JState.QUEUED || it.state == JState.RUNNING }.forEach { cancel(it.key) }

    fun isCancelled(key: String) = synchronized(lock) { key in cancelled }

    fun clearFinished() = synchronized(lock) {
        jobs.value = jobs.value.filter { it.state == JState.QUEUED || it.state == JState.RUNNING }
    }

    /** Dịch vụ bị hệ thống tắt giữa chừng: trả file đang tải về hàng chờ. */
    fun stopped() = synchronized(lock) {
        active.value = false
        jobs.value = jobs.value.map { if (it.state == JState.RUNNING) it.copy(state = JState.QUEUED) else it }
    }
}

class DownloadService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var working = false
    private var finished = 0
    private var failed = 0
    private var lastNotify = 0L

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val n = notification("Đang chuẩn bị tải…", 0, 0)
        if (Build.VERSION.SDK_INT >= 29) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        else startForeground(ID, n)
        if (!working) {
            working = true
            scope.launch { work() }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        scope.cancel()
        Downloads.stopped()
        super.onDestroy()
    }

    private fun work() {
        val wake = (getSystemService(POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "CircleVault:tai").apply { setReferenceCounted(false); acquire(6 * 3600_000L) }
        @Suppress("DEPRECATION")
        val wifi = (applicationContext.getSystemService(WIFI_SERVICE) as WifiManager)
            .createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "CircleVault:tai").apply { setReferenceCounted(false); acquire() }
        try {
            while (true) {
                val j = Downloads.next() ?: break
                fetch(j)
            }
        } finally {
            runCatching { kotlinx.coroutines.runBlocking { YouTube.flushReports() } }   // báo máy tính các bài vừa lưu từ YouTube
            runCatching { wake.release() }
            runCatching { wifi.release() }
            working = false
            stopForeground(STOP_FOREGROUND_REMOVE)
            notifyDone()
            stopSelf()
        }
    }

    private fun fetch(j0: DJob) {
        var j = j0
        var extra: Map<String, String> = emptyMap()
        if (j.online != null) {
            // bài YouTube: lấy link lúc tải (qua máy tính nếu được, không thì tự lấy); đuôi file theo định dạng thật
            val r = try {
                YouTube.resolve(j.online!!.yt)
            } catch (e: Throwable) {
                failed++
                Downloads.update(j.key) { it.copy(state = JState.ERROR, error = "Không lấy được bài: ${e.message ?: "lỗi"}") }
                return
            }
            val dir = File(Store.baseDir(), "nhac")
            val stem = "yt-${j.online!!.yt} - ${safeName(j.title)}"
            val prev = dir.listFiles()?.firstOrNull { it.name.startsWith(stem) && it.name.endsWith(".part") }
            val dest = prev?.path?.removeSuffix(".part") ?: File(dir, "$stem.${r.ext.ifBlank { "m4a" }}").path
            j = j.copy(url = r.url, dest = dest)
            extra = r.headers
            Downloads.update(j.key) { it.copy(url = r.url, dest = dest) }
        }
        val dest = File(j.dest)
        val part = File(j.dest + ".part")
        try {
            dest.parentFile?.mkdirs()
            var have = if (part.exists()) part.length() else 0L
            var total = j.total
            if (j.drive != null) {
                extra = mapOf("Authorization" to "Bearer " + try {
                    Drive.tokenBlocking(this, j.drive!!.first)
                } catch (e: Throwable) {
                    throw IOException("Mở app CircleVault → Online → Drive để cấp quyền Google Drive lại.")
                })
            }
            // KHÔNG gửi mã ghép của máy tính tới YouTube / Google
            val rb = if (j.online != null || j.drive != null) Request.Builder().url(j.url) else Api.authed(j.url)
            extra.forEach { (k, v) -> rb.header(k, v) }
            if (have > 0) rb.header("Range", "bytes=$have-")
            Api.http.newBuilder().readTimeout(60, TimeUnit.SECONDS).build().newCall(rb.build()).execute().use { r ->
                if (r.code == 401) throw IOException("Thiết bị này đã bị thu hồi quyền trên máy tính.")
                val already = r.code == 416 && have > 0 && have >= j.total
                if (!already) {
                    if (!r.isSuccessful) throw IOException(Api.detail(r.body?.string()) ?: "Máy tính báo lỗi ${r.code}")
                    val body = r.body ?: throw IOException("Máy tính không gửi dữ liệu")
                    val append = r.code == 206 && have > 0
                    if (!append) have = 0
                    total = if (body.contentLength() > 0) have + body.contentLength() else j.total
                    Downloads.update(j.key) { it.copy(done = have, total = total) }
                    FileOutputStream(part, append).use { out ->
                        body.byteStream().use { inp ->
                            val buf = ByteArray(256 * 1024)
                            var t0 = 0L
                            while (true) {
                                val n = inp.read(buf)
                                if (n < 0) break
                                if (Downloads.isCancelled(j.key)) throw Cancelled()
                                out.write(buf, 0, n)
                                have += n
                                val now = SystemClock.elapsedRealtime()
                                if (now - t0 > 400) {
                                    t0 = now
                                    Downloads.update(j.key) { it.copy(done = have) }
                                    progress(j, have, total)
                                }
                            }
                        }
                    }
                }
            }
            if (Downloads.isCancelled(j.key)) throw Cancelled()
            dest.delete()
            if (!part.renameTo(dest)) throw IOException("Không ghi được file vào bộ nhớ")
            val cover = j.coverUrl?.let { saveCover(it, j) }
            j.track?.let { Store.addTrack(OTrack(it.id, it.title, it.artist, it.duration, dest.length(), dest.path, cover)) }
            j.video?.let { Store.addVideo(OVideo(it.id, it.title, it.duration, dest.length(), dest.path, cover)) }
            j.drive?.let { (_, gid) ->
                val mmr = android.media.MediaMetadataRetriever()
                val meta = runCatching {
                    mmr.setDataSource(dest.path)
                    Triple(
                        mmr.extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_TITLE),
                        mmr.extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_ARTIST),
                        (mmr.extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L) / 1000.0,
                    )
                }.getOrDefault(Triple(null, null, 0.0))
                runCatching { mmr.release() }
                val title = meta.first?.takeIf { it.isNotBlank() } ?: j.title
                if (dest.extension.lowercase() in setOf("mp4", "mkv", "mov", "m4v")) {
                    Store.addVideo(OVideo(Prefs.nextLocalId(), title, meta.third, dest.length(), dest.path, null))
                } else {
                    val id = Store.byGd(gid)?.id ?: Prefs.nextLocalId()
                    Store.addTrack(OTrack(id, title, meta.second, meta.third, dest.length(), dest.path, null, gd = gid))
                    j.onlinePlaylist?.let { (pid, name) -> Store.addToPlaylist(pid, name, id) }
                }
            }
            j.online?.let { o ->
                val id = Store.byYt(o.yt)?.id ?: Prefs.nextLocalId()
                Store.addTrack(OTrack(id, o.title, o.artist, o.duration, dest.length(), dest.path, cover, yt = o.yt))
                j.onlinePlaylist?.let { (pid, name) -> Store.addToPlaylist(pid, name, id) }
                YouTube.queueReport(o, j.onlinePlaylist?.second)
            }
            Downloads.update(j.key) { it.copy(state = JState.DONE, done = dest.length(), total = dest.length()) }
            finished++
        } catch (e: Cancelled) {
            part.delete()
        } catch (e: Exception) {
            failed++
            val msg = when (e) {
                is ConnectException, is SocketTimeoutException, is UnknownHostException ->
                    "Mất kết nối với máy tính. Bấm Thử lại khi máy tính bật (tải tiếp chỗ đang dở)."
                else -> e.message ?: "Lỗi không rõ"
            }
            Downloads.update(j.key) { it.copy(state = JState.ERROR, error = msg) }
        }
    }

    private fun saveCover(url: String, j: DJob): String? = runCatching {
        val f = File(File(Store.baseDir(), "bia"), "${j.key}.jpg")
        f.parentFile?.mkdirs()
        val rb = if (j.coverAuth) Api.authed(url) else Request.Builder().url(url)
        Api.http.newBuilder().callTimeout(8, TimeUnit.SECONDS).build().newCall(rb.build()).execute().use { r ->
            if (!r.isSuccessful) return null
            r.body?.byteStream()?.use { inp -> f.outputStream().use { inp.copyTo(it) } }
        }
        f.path
    }.getOrNull()

    private fun progress(j: DJob, have: Long, total: Long) {
        val now = SystemClock.elapsedRealtime()
        if (now - lastNotify < 900) return
        lastNotify = now
        val left = Downloads.jobs.value.count { it.state == JState.QUEUED }
        val text = "${fmtBytes(have)} / ${fmtBytes(total)}" + if (left > 0) " · còn $left file chờ" else ""
        if (canNotify()) NotificationManagerCompat.from(this).notify(ID, notification(j.title, have, total, text))
    }

    private fun canNotify() = Build.VERSION.SDK_INT < 33 ||
        ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    private fun openApp(): PendingIntent = PendingIntent.getActivity(
        this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun notification(title: String, have: Long, total: Long, text: String? = null): Notification =
        NotificationCompat.Builder(this, App.CH_DOWNLOAD)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(title)
            .setContentText(text ?: "CircleVault đang tải về điện thoại")
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(openApp())
            .setProgress(100, if (total > 0) (have * 100 / total).toInt() else 0, total <= 0)
            .build()

    private fun notifyDone() {
        if ((finished == 0 && failed == 0) || !canNotify()) return
        val text = buildString {
            if (finished > 0) append("Đã tải xong $finished file. Tắt máy tính rồi vẫn nghe, xem được.")
            if (failed > 0) append(if (finished > 0) " " else "").append("$failed file lỗi: mở app để thử lại.")
        }
        NotificationManagerCompat.from(this).notify(
            ID + 1,
            NotificationCompat.Builder(this, App.CH_DONE).setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(if (failed > 0) "Tải về chưa xong hết" else "Tải về xong")
                .setContentText(text).setStyle(NotificationCompat.BigTextStyle().bigText(text))
                .setContentIntent(openApp()).setAutoCancel(true).build(),
        )
    }

    private class Cancelled : Exception()

    companion object {
        const val ID = 41
    }
}
