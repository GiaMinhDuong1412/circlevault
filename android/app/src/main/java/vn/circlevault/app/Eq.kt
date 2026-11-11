package vn.circlevault.app

import android.media.audiofx.Equalizer
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.abs
import kotlin.math.ln
import kotlin.math.roundToInt

/**
 * Bộ chỉnh âm của điện thoại (android.media.audiofx.Equalizer) gắn vào phiên âm thanh của trình phát nhạc.
 * Lưu theo 5 dải chuẩn (60, 230, 910, 3600, 14000 Hz, đơn vị dB) rồi quy đổi sang các dải thật của máy.
 * Mỗi bài có thể có EQ riêng (khóa = mediaId: t<id> bài trên máy tính, y<id> bài YouTube); không có thì dùng EQ mặc định.
 */
object Eq {
    val REF_HZ = listOf(60, 230, 910, 3600, 14000)

    /** Kiểu dựng sẵn, dB theo 5 dải chuẩn */
    val PRESETS = linkedMapOf(
        "Phẳng" to listOf(0f, 0f, 0f, 0f, 0f),
        "Tăng bass" to listOf(6f, 4f, 0f, 0f, 1f),
        "Giọng hát" to listOf(-2f, 0f, 3f, 4f, 1f),
        "Bolero" to listOf(3f, 2f, 1f, 3f, 2f),
        "Nhạc trẻ" to listOf(4f, 1f, -1f, 2f, 4f),
        "Rock" to listOf(5f, 2f, -2f, 3f, 5f),
        "Cổ điển" to listOf(3f, 1f, -1f, 2f, 3f),
    )

    private var eq: Equalizer? = null
    var supported by mutableStateOf(true)
    var levels by mutableStateOf(List(5) { 0f })      // dB theo REF_HZ
    var own by mutableStateOf(false)                  // bài đang phát có EQ riêng
    var key by mutableStateOf<String?>(null)
    var enabled by mutableStateOf(Prefs.eqOn)
    private var range = -15f to 15f

    val minDb get() = range.first
    val maxDb get() = range.second

    fun attach(session: Int) {
        release()
        if (session == 0) return
        eq = runCatching { Equalizer(0, session) }.getOrNull()
        supported = eq != null
        eq?.let {
            val r = it.bandLevelRange
            range = (r[0] / 100f).coerceAtLeast(-15f) to (r[1] / 100f).coerceAtMost(15f)
            it.enabled = enabled
        }
        apply(levels)
    }

    fun release() {
        runCatching { eq?.release() }
        eq = null
    }

    private fun parse(s: String): List<Float>? = runCatching {
        val a = JSONArray(s)
        (0 until 5).map { a.getDouble(it).toFloat() }
    }.getOrNull()

    private fun tracks(): JSONObject = runCatching { JSONObject(Prefs.eqTracks) }.getOrDefault(JSONObject())

    fun defaultLevels(): List<Float> = parse(Prefs.eqDefault) ?: PRESETS.getValue("Phẳng")

    /** đổi bài → áp EQ riêng của bài, không có thì EQ mặc định */
    fun onTrack(mediaId: String?) {
        key = mediaId
        val mine = mediaId?.let { tracks().optJSONArray(it) }?.let { parse(it.toString()) }
        own = mine != null
        apply(mine ?: defaultLevels())
    }

    private fun apply(db: List<Float>) {
        levels = db
        val e = eq ?: return
        runCatching {
            for (b in 0 until e.numberOfBands) {
                val hz = e.getCenterFreq(b.toShort()) / 1000f
                e.setBandLevel(b.toShort(), (interp(db, hz) * 100).roundToInt().toShort())
            }
        }
    }

    /** nội suy theo thang log tần số giữa 5 dải chuẩn */
    private fun interp(db: List<Float>, hz: Float): Float {
        val x = ln(hz.coerceAtLeast(20f))
        val xs = REF_HZ.map { ln(it.toFloat()) }
        if (x <= xs.first()) return db.first()
        if (x >= xs.last()) return db.last()
        val i = xs.indexOfLast { it <= x }
        val t = (x - xs[i]) / (xs[i + 1] - xs[i])
        return db[i] + (db[i + 1] - db[i]) * t
    }

    private fun persist() {
        val arr = JSONArray(levels.map { it.toDouble() })
        if (own && key != null) {
            Prefs.eqTracks = tracks().put(key, arr).toString()
        } else {
            Prefs.eqDefault = arr.toString()
        }
    }

    fun setLevel(i: Int, db: Float) {
        apply(levels.toMutableList().also { it[i] = db.coerceIn(minDb, maxDb) })
        persist()
    }

    fun preset(name: String) {
        apply(PRESETS[name] ?: return)
        persist()
    }

    fun presetName(): String? = PRESETS.entries.firstOrNull { (_, v) -> v.zip(levels).all { (a, b) -> abs(a - b) < 0.3f } }?.key

    /** bật/tắt "EQ riêng cho bài này" */
    fun useOwn(on: Boolean) {
        val k = key ?: return
        own = on
        if (on) persist()
        else {
            val t = tracks().apply { remove(k) }
            Prefs.eqTracks = t.toString()
            apply(defaultLevels())
        }
    }

    fun turn(on: Boolean) {
        enabled = on
        Prefs.eqOn = on
        runCatching { eq?.enabled = on }
    }

    fun label(hz: Int) = if (hz >= 1000) "${if (hz % 1000 == 0) hz / 1000 else "%.1f".format(hz / 1000f)}k" else "$hz"
}
