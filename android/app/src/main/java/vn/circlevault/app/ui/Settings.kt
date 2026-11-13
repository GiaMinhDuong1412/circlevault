package vn.circlevault.app.ui

import android.widget.Toast
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import vn.circlevault.app.BuildConfig
import vn.circlevault.app.MainVM
import vn.circlevault.app.Prefs
import vn.circlevault.app.Store
import vn.circlevault.app.Updater
import vn.circlevault.app.fmtBytes

@Composable
fun SettingsTab(vm: MainVM) {
    val c = cv
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var vol by remember { mutableStateOf(Prefs.volume) }
    var ask by remember { mutableStateOf(false) }
    val vols = remember { Store.volumes() }
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        // ---- cập nhật
        Card(color = if (Updater.hasNew) c.green else c.surface) {
            H("Cập nhật app")
            val l = Updater.latest
            Text(
                when {
                    Updater.hasNew -> "Có bản mới ${l?.version} (đang dùng ${BuildConfig.VERSION_NAME})."
                    l != null -> "Đang dùng bản mới nhất (${BuildConfig.VERSION_NAME})."
                    else -> "Đang dùng bản ${BuildConfig.VERSION_NAME}."
                },
                color = c.text, fontWeight = FontWeight.Bold,
            )
            if (Updater.hasNew && !l?.notes.isNullOrBlank()) Hint(l!!.notes.lines().take(8).joinToString("\n"))
            if (Updater.downloading) Bar(Updater.dlProgress, color = c.cyan)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (Updater.hasNew) {
                    BButton(if (Updater.downloading) "Đang tải… ${(Updater.dlProgress * 100).toInt()}%" else "Cập nhật ngay", {
                        scope.launch { Updater.install(ctx)?.let { vm.toast(it) } }
                    }, enabled = !Updater.downloading, color = c.yellow, small = true)
                }
                BButton(if (Updater.checking) "Đang kiểm tra…" else "Kiểm tra bản mới", {
                    scope.launch {
                        val i = Updater.check()
                        vm.toast(if (i == null) "Không kiểm tra được (cần Internet)." else if (Updater.hasNew) "Có bản mới ${i.version}." else "Đang dùng bản mới nhất.")
                    }
                }, enabled = !Updater.checking, color = c.surface, small = true)
            }
            Hint("App tự kiểm tra mỗi 12 giờ, mỗi bản mới chỉ báo một lần. Cập nhật không mất nhạc, phim đã tải.")
        }

        // ---- kiểu giao diện (đổi = khởi động lại app)
        Card {
            H("Kiểu giao diện")
            Hint("Giống app máy tính. Đổi kiểu cần khởi động lại app (nhạc đang phát sẽ dừng).")
            var pick by remember { mutableStateOf<String?>(null) }
            STYLES.chunked(2).forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    row.forEach { (k, name, sub) ->
                        val on = UiStyle.key == k
                        Column(
                            Modifier.weight(1f).brutal(if (on) c.yellow else c.surface, c.ink, shadow = 2.dp, border = 2.dp)
                                .clickable { if (!on) pick = k }.padding(10.dp),
                            verticalArrangement = Arrangement.spacedBy(2.dp),
                        ) {
                            Text(name, color = if (on) c.onAccent else c.text, fontWeight = FontWeight.Bold, fontSize = 14.sp)
                            Text(if (on) "Đang dùng" else sub, color = if (on) c.onAccent else c.muted, fontSize = 12.sp)
                        }
                    }
                    repeat(2 - row.size) { Spacer(Modifier.weight(1f)) }
                }
            }
            pick?.let { k ->
                Confirm(
                    "Đổi sang \"${STYLES.first { it.first == k }.second}\"?",
                    "App sẽ tự đóng và mở lại để áp dụng kiểu giao diện mới.",
                    "Khởi động lại", onOk = { Prefs.uiStyle = k; restartApp(ctx) }, onDismiss = { pick = null },
                )
            }
            BButton("📜 Có gì mới", { vm.showNotes = true }, color = c.surface, small = true)
        }

        // ---- theme
        Card {
            H("Giao diện")
            val opts = listOf(Triple("", "Theo máy", null)) + THEMES.map { Triple(it.first, it.second, it.third) }
            opts.chunked(3).forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    row.forEach { (k, name, pal) ->
                        val on = ThemeState.key == k
                        Column(
                            Modifier.weight(1f).brutal(if (on) c.yellow else c.surface, c.ink, shadow = 2.dp, border = 2.dp)
                                .clickable { ThemeState.set(k) }.padding(8.dp),
                            horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            val p = pal ?: if (c.dark) DarkCv else LightCv
                            Canvas(Modifier.fillMaxWidth().height(26.dp)) {
                                val w = size.width / 4
                                listOf(p.bg, p.cyan, p.yellow, p.green).forEachIndexed { i, col ->
                                    drawRect(col, topLeft = Offset(i * w, 0f), size = Size(w, size.height))
                                }
                                drawRect(p.ink, style = androidx.compose.ui.graphics.drawscope.Stroke(2.dp.toPx()))
                            }
                            Text(name, color = if (on) c.onAccent else c.text, fontWeight = FontWeight.Bold, fontSize = 13.sp)
                        }
                    }
                    repeat(3 - row.size) { Spacer(Modifier.weight(1f)) }
                }
            }
        }

        // ---- nơi lưu
        Card {
            H("Nơi lưu nhạc, phim")
            vols.forEach { v ->
                val on = v.index == vol || (vols.none { it.index == vol } && v == vols.first())
                Row(
                    Modifier.fillMaxWidth()
                        .brutal(if (on) c.green else c.surface, c.ink, shadow = 2.dp, border = 2.dp)
                        .clickable {
                            vol = v.index; Prefs.volume = v.index
                            Toast.makeText(ctx, "Từ giờ tải vào ${v.label}.", Toast.LENGTH_SHORT).show()
                        }
                        .padding(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(v.label, color = if (on) c.onAccent else c.text, fontWeight = FontWeight.ExtraBold)
                        Text("Còn trống ${fmtBytes(v.free)} / ${fmtBytes(v.total)}", color = if (on) c.onAccent else c.muted, fontSize = 13.5.sp)
                    }
                    if (on) Icon(Ic.check, null, tint = c.onAccent)
                }
            }
            if (vols.size < 2) Hint("Không thấy thẻ nhớ. Nếu điện thoại có lắp thẻ, kiểm tra thẻ đã được nhận trong Cài đặt → Bộ nhớ.")
            Hint("Đổi nơi lưu chỉ áp dụng cho lần tải sau. Gỡ app thì nhạc, phim đã tải trong app cũng bị xóa (cập nhật app thì không).")
        }

        // ---- máy tính
        Card {
            H("Máy tính")
            if (vm.paired) {
                Text(vm.pcName.ifBlank { "Máy tính" }, color = c.text, fontWeight = FontWeight.Bold)
                Hint("${Prefs.base.removePrefix("http://")} · điện thoại này: ${Prefs.deviceName.ifBlank { MainVM.defaultName() }}")
                BButton("Ghép lại / đổi máy tính", { ask = true }, color = c.surface, small = true)
            } else {
                Hint("Chưa ghép. Ghép để tải nhạc, phim từ máy tính và nghe playlist YouTube của bạn.")
                BButton("Ghép với máy tính", { vm.tab = 2 }, small = true)
            }
        }
        Box(Modifier.size(1.dp))
    }
    if (ask) {
        Confirm(
            "Ghép lại với máy tính?", "Điện thoại sẽ ngắt kết nối với máy tính hiện tại, rồi bạn quét mã ghép mới. Nhạc, phim đã tải vẫn giữ nguyên.",
            "Ngắt kết nối", { vm.unpair() },
        ) { ask = false }
    }
}


/** Đóng hẳn rồi mở lại app (kiểu giao diện chỉ đọc lúc mở app). */
internal fun restartApp(ctx: android.content.Context) {
    val i = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName) ?: return
    i.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK or android.content.Intent.FLAG_ACTIVITY_CLEAR_TASK)
    val pi = android.app.PendingIntent.getActivity(ctx, 7, i, android.app.PendingIntent.FLAG_IMMUTABLE or android.app.PendingIntent.FLAG_CANCEL_CURRENT)
    val am = ctx.getSystemService(android.content.Context.ALARM_SERVICE) as android.app.AlarmManager
    am.set(android.app.AlarmManager.RTC, System.currentTimeMillis() + 400, pi)
    android.os.Process.killProcess(android.os.Process.myPid())
}
