package vn.circlevault.app

import android.Manifest
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * Cập nhật app: đọc bản mới nhất ở repo public circlevault-releases (cùng nơi app máy tính lấy bản mới).
 * - Kiểm tra khi mở app và mỗi 12 giờ (WorkManager); MỖI BẢN CHỈ BÁO MỘT LẦN (nhớ trong Prefs.updNotified).
 * - "Để sau" thì không hiện lại cho bản đó (vẫn thấy trong Cài đặt); bản sau mới báo tiếp.
 * - Tải APK vào cache (tải rồi thì không tải lại), mở trình cài của Android.
 */
object Updater {
    private const val API = "https://api.github.com/repos/GiaMinhDuong1412/circlevault-releases/releases/latest"
    const val CH = "cap-nhat"

    data class Info(val tag: String, val version: String, val code: Int, val url: String, val size: Long, val notes: String)

    var latest by mutableStateOf<Info?>(null)
    var downloading by mutableStateOf(false)
    var dlProgress by mutableStateOf(0f)
    var checking by mutableStateOf(false)

    /** v2026.11.15 → 26110015 (cùng công thức với CI) */
    fun codeOf(tag: String): Int? {
        val p = tag.removePrefix("v").split(".").mapNotNull { it.toIntOrNull() }
        if (p.size < 3) return null
        return (p[0] - 2000) * 1_000_000 + p[1] * 10_000 + p[2]
    }

    val hasNew get() = latest?.let { it.code > BuildConfig.VERSION_CODE } == true

    /** banner trong app: có bản mới và người dùng chưa bấm "Để sau" cho bản này */
    val showBanner get() = hasNew && latest?.tag != Prefs.updLater

    suspend fun check(): Info? = withContext(Dispatchers.IO) {
        checking = true
        try {
            val req = Request.Builder().url(API).header("Accept", "application/vnd.github+json").build()
            Api.http.newCall(req).execute().use { r ->
                if (!r.isSuccessful) return@withContext null
                val j = JSONObject(r.body?.string() ?: "{}")
                val tag = j.optString("tag_name")
                val code = codeOf(tag) ?: return@withContext null
                val assets = j.optJSONArray("assets")
                val apk = (0 until (assets?.length() ?: 0)).map { assets!!.getJSONObject(it) }
                    .firstOrNull { it.optString("name") == "CircleVault-Android.apk" } ?: return@withContext null
                val info = Info(tag, tag.removePrefix("v"), code, apk.getString("browser_download_url"), apk.optLong("size"),
                    j.optString("body").substringAfter("Thay đổi:", "").trim().take(1500))
                latest = info
                Prefs.updCheckedAt = System.currentTimeMillis()
                info
            }
        } catch (e: Exception) {
            null
        } finally {
            checking = false
        }
    }

    fun later() {
        latest?.let { Prefs.updLater = it.tag }
    }

    private fun apkFile(ctx: Context, i: Info) = File(File(ctx.cacheDir, "update").apply { mkdirs() }, "CircleVault-${i.version}.apk")

    /** tải (nếu chưa có) rồi mở trình cài */
    suspend fun install(ctx: Context): String? {
        val i = latest ?: return "Chưa thấy bản mới."
        if (Build.VERSION.SDK_INT >= 26 && !ctx.packageManager.canRequestPackageInstalls()) {
            ctx.startActivity(
                Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${ctx.packageName}"))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
            return "Cho phép CircleVault cài ứng dụng, rồi bấm Cập nhật lần nữa."
        }
        val f = apkFile(ctx, i)
        if (!(f.exists() && (i.size <= 0 || f.length() == i.size))) {
            downloading = true
            dlProgress = 0f
            try {
                withContext(Dispatchers.IO) {
                    f.parentFile?.listFiles()?.filter { it.name != f.name }?.forEach { it.delete() }   // bỏ bản cũ
                    val tmp = File(f.path + ".part")
                    Api.http.newBuilder().readTimeout(60, TimeUnit.SECONDS).build()
                        .newCall(Request.Builder().url(i.url).build()).execute().use { r ->
                            if (!r.isSuccessful) throw IllegalStateException("Lỗi ${r.code}")
                            val total = r.body!!.contentLength().takeIf { it > 0 } ?: i.size
                            r.body!!.byteStream().use { inp ->
                                tmp.outputStream().use { out ->
                                    val buf = ByteArray(128 * 1024)
                                    var have = 0L
                                    while (true) {
                                        val n = inp.read(buf)
                                        if (n < 0) break
                                        out.write(buf, 0, n)
                                        have += n
                                        if (total > 0) dlProgress = have.toFloat() / total
                                    }
                                }
                            }
                        }
                    tmp.renameTo(f)
                }
            } catch (e: Exception) {
                return "Không tải được bản mới: ${e.message}"
            } finally {
                downloading = false
            }
        }
        val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.files", f)
        ctx.startActivity(
            Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK),
        )
        return null
    }

    /** thông báo hệ thống – mỗi bản một lần */
    fun notifyOnce(ctx: Context) {
        val i = latest ?: return
        if (!hasNew || Prefs.updNotified == i.tag) return
        Prefs.updNotified = i.tag
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return
        val open = PendingIntent.getActivity(
            ctx, 2, Intent(ctx, MainActivity::class.java).putExtra("update", true).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        NotificationManagerCompat.from(ctx).notify(
            77,
            NotificationCompat.Builder(ctx, CH).setSmallIcon(R.drawable.ic_stat)
                .setContentTitle("CircleVault có bản mới ${i.version}")
                .setContentText("Bấm để cập nhật. Nhạc, phim đã tải vẫn giữ nguyên.")
                .setContentIntent(open).setAutoCancel(true).build(),
        )
    }

    fun schedule(ctx: Context) {
        val req = PeriodicWorkRequestBuilder<Worker>(12, TimeUnit.HOURS)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        WorkManager.getInstance(ctx).enqueueUniquePeriodicWork("kiem-tra-cap-nhat", ExistingPeriodicWorkPolicy.KEEP, req)
    }

    class Worker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
        override suspend fun doWork(): Result {
            check()
            notifyOnce(applicationContext)
            return Result.success()
        }
    }
}
