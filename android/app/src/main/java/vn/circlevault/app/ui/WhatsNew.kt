package vn.circlevault.app.ui

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import org.json.JSONObject
import vn.circlevault.app.BuildConfig
import vn.circlevault.app.Prefs

/** "Có gì mới" – cùng file ghi chú với app máy tính (frontend/thay-doi/thay-doi.json, đóng gói vào assets). */
object WhatsNew {
    data class Entry(val id: String, val title: String, val date: String, val items: List<String>)

    fun all(ctx: Context): List<Entry> = runCatching {
        val j = JSONObject(ctx.assets.open("thay-doi.json").bufferedReader(Charsets.UTF_8).use { it.readText() })
        val a = j.getJSONArray("entries")
        (0 until a.length()).map { i ->
            val e = a.getJSONObject(i)
            val it = e.optJSONArray("items")
            Entry(e.optString("id"), e.optString("title"), e.optString("date"),
                if (it == null) emptyList() else (0 until it.length()).map { k -> it.getString(k) })
        }.filter { it.id.isNotBlank() }
    }.getOrDefault(emptyList())

    /** Mục chưa xem: lần đầu cài chỉ hiện mục mới nhất; sau đó hiện mọi mục mới hơn mục đã xem. */
    fun unseen(ctx: Context): List<Entry> {
        val list = all(ctx)
        if (list.isEmpty()) return list
        val seen = Prefs.notesSeen
        if (seen.isBlank()) return list.take(1)
        val i = list.indexOfFirst { it.id == seen }
        return if (i < 0) list.take(3) else list.take(i)
    }

    fun markSeen(ctx: Context) {
        all(ctx).firstOrNull()?.let { Prefs.notesSeen = it.id }
    }
}

/** Cuộn giấy: 2 trục cuộn (vàng, đầu hồng) + tờ giấy mở dần ra, viền mực theo theme. */
@Composable
fun ScrollNotes(list: List<WhatsNew.Entry>, onDone: () -> Unit) {
    val c = cv
    val open = remember { Animatable(0f) }
    LaunchedEffect(Unit) { open.animateTo(1f, tween(700)) }
    Dialog(onDismissRequest = onDone, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 18.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Roller()
            Box(
                Modifier.fillMaxWidth().padding(horizontal = 14.dp).offset(y = (-8).dp)
                    .heightIn(max = (560 * open.value).dp)
                    .background(lerp(c.surface, c.yellow, 0.1f))
                    .border(2.dp, c.ink)
            ) {
                Column(
                    Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 22.dp, vertical = 26.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text("CIRCLEVAULT · BẢN ${BuildConfig.VERSION_NAME}", color = c.muted, fontSize = 11.sp, fontFamily = FontFamily.Monospace,
                        fontWeight = FontWeight.Bold, letterSpacing = 1.5.sp)
                    Text("Có gì mới", color = c.text, fontSize = 28.sp, fontWeight = FontWeight.Black)
                    list.forEachIndexed { i, e ->
                        if (i > 0) HorizontalDivider(color = c.ink.copy(alpha = 0.25f), thickness = 2.dp, modifier = Modifier.padding(vertical = 8.dp))
                        Text(e.title, color = c.text, fontSize = 16.sp, fontWeight = FontWeight.ExtraBold)
                        if (e.date.isNotBlank()) Text(e.date, color = c.muted, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
                        e.items.forEach { t ->
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Text("✦", color = c.cyan, fontWeight = FontWeight.Black)
                                Text(t, color = c.text, fontSize = 14.5.sp, lineHeight = 21.sp)
                            }
                        }
                    }
                    Box(Modifier.fillMaxWidth().padding(top = 14.dp), contentAlignment = Alignment.Center) {
                        BButton("Đã hiểu", onDone)
                    }
                }
            }
            Box(Modifier.offset(y = (-16).dp)) { Roller() }
        }
    }
}

@Composable
private fun Roller() {
    val c = cv
    Box(Modifier.fillMaxWidth().height(40.dp), contentAlignment = Alignment.Center) {
        Box(
            Modifier.fillMaxWidth().padding(horizontal = 10.dp).height(32.dp).clip(RoundedCornerShape(16.dp))
                .background(Brush.verticalGradient(listOf(lerp(c.yellow, Color.White, 0.5f), c.yellow, lerp(c.yellow, Color.Black, 0.28f))))
                .border(2.5.dp, c.ink, RoundedCornerShape(16.dp))
        ) {
            Box(Modifier.fillMaxWidth().padding(horizontal = 14.dp).offset(y = 8.dp).height(4.dp).clip(RoundedCornerShape(2.dp))
                .background(Color.White.copy(alpha = 0.55f)))
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            repeat(2) {
                Box(Modifier.width(20.dp).height(40.dp).clip(RoundedCornerShape(7.dp))
                    .background(Brush.verticalGradient(listOf(lerp(c.pink, Color.White, 0.5f), c.pink, lerp(c.pink, Color.Black, 0.3f))))
                    .border(2.5.dp, c.ink, RoundedCornerShape(7.dp)))
            }
        }
    }
}
