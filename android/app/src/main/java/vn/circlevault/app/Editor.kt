package vn.circlevault.app

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.UnstableApi
import androidx.media3.transformer.Composition
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.EditedMediaItemSequence
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.ProgressHolder
import androidx.media3.transformer.Transformer
import java.io.File

/**
 * Cắt đoạn / ghép nhiều bài trên điện thoại bằng Media3 Transformer (mã hóa lại sang AAC, file .m4a).
 * Luôn tạo FILE MỚI trong thư mục "cat-ghep" của app, không sửa file gốc; xong thì thêm vào thư viện (id âm).
 */
@UnstableApi
object Editor {
    var busy by mutableStateOf<String?>(null)          // đang làm gì (hiện trên giao diện)
    var progress by mutableStateOf(0f)
    private val main = Handler(Looper.getMainLooper())

    private fun outFile(name: String): File {
        val dir = File(Store.baseDir(), "cat-ghep").apply { mkdirs() }
        var f = File(dir, "${safeName(name)}.m4a")
        var i = 2
        while (f.exists()) f = File(dir, "${safeName(name)} ($i).m4a").also { i++ }
        return f
    }

    private fun item(t: OTrack, startMs: Long? = null, endMs: Long? = null): EditedMediaItem {
        val b = MediaItem.Builder().setUri(Uri.fromFile(File(t.path)))
        if (startMs != null || endMs != null) {
            b.setClippingConfiguration(
                MediaItem.ClippingConfiguration.Builder()
                    .setStartPositionMs(startMs ?: 0)
                    .apply { if (endMs != null) setEndPositionMs(endMs) }
                    .build(),
            )
        }
        return EditedMediaItem.Builder(b.build()).setRemoveVideo(true).build()
    }

    /** cắt [startMs, endMs] của một bài */
    fun cut(ctx: Context, t: OTrack, startMs: Long, endMs: Long, name: String, done: (String?) -> Unit) {
        val out = outFile(name)
        val dur = (endMs - startMs) / 1000.0
        run(ctx, "Đang cắt \"${t.title}\"", Composition.Builder(EditedMediaItemSequence(listOf(item(t, startMs, endMs)))).build(), out) { err ->
            if (err == null) Store.addTrack(OTrack(Prefs.nextLocalId(), name, t.artist, dur, out.length(), out.path, t.cover))
            done(err)
        }
    }

    /** ghép các bài theo thứ tự */
    fun merge(ctx: Context, tracks: List<OTrack>, name: String, done: (String?) -> Unit) {
        val out = outFile(name)
        val seq = EditedMediaItemSequence(tracks.map { item(it) })
        run(ctx, "Đang ghép ${tracks.size} bài", Composition.Builder(seq).build(), out) { err ->
            if (err == null) {
                val artist = tracks.mapNotNull { it.artist }.distinct().joinToString(", ").take(80).ifBlank { null }
                Store.addTrack(OTrack(Prefs.nextLocalId(), name, artist, tracks.sumOf { it.duration }, out.length(), out.path, tracks.firstNotNullOfOrNull { it.cover }))
            }
            done(err)
        }
    }

    private fun run(ctx: Context, label: String, comp: Composition, out: File, done: (String?) -> Unit) {
        if (busy != null) {
            done("Đang làm việc khác, đợi xong đã."); return
        }
        busy = label
        progress = 0f
        val holder = ProgressHolder()
        lateinit var tick: Runnable
        val tr = Transformer.Builder(ctx)
            .setAudioMimeType(MimeTypes.AUDIO_AAC)
            .addListener(object : Transformer.Listener {
                override fun onCompleted(composition: Composition, exportResult: ExportResult) {
                    main.removeCallbacks(tick)
                    busy = null
                    done(null)
                }

                override fun onError(composition: Composition, exportResult: ExportResult, exportException: ExportException) {
                    main.removeCallbacks(tick)
                    busy = null
                    out.delete()                    // chỉ xóa file kết quả dở, không đụng file gốc
                    done(exportException.message ?: "Không xử lý được file này")
                }
            })
            .build()
        tick = Runnable {
            if (tr.getProgress(holder) == Transformer.PROGRESS_STATE_AVAILABLE) progress = holder.progress / 100f
            main.postDelayed(tick, 300)
        }
        main.post {
            try {
                tr.start(comp, out.path)
                main.postDelayed(tick, 300)
            } catch (e: Exception) {
                busy = null
                done(e.message ?: "Lỗi")
            }
        }
    }
}
