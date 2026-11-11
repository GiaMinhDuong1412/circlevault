package vn.circlevault.app.ui

import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import coil.compose.AsyncImage
import coil.request.ImageRequest
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import kotlinx.coroutines.delay
import vn.circlevault.app.Api
import vn.circlevault.app.BuildConfig
import vn.circlevault.app.DJob
import vn.circlevault.app.Downloads
import vn.circlevault.app.Editor
import vn.circlevault.app.Updater
import vn.circlevault.app.YouTube
import vn.circlevault.app.JState
import vn.circlevault.app.MainVM
import vn.circlevault.app.OPlaylist
import vn.circlevault.app.OTrack
import vn.circlevault.app.OVideo
import vn.circlevault.app.PlayerConn
import vn.circlevault.app.Prefs
import vn.circlevault.app.RPlaylist
import vn.circlevault.app.RTrack
import vn.circlevault.app.RVideo
import vn.circlevault.app.Store
import vn.circlevault.app.fmtBytes
import vn.circlevault.app.fmtDur
import java.io.File

/* ------------------------------------------------------------------ khung app: nội dung + trình phát mini + thanh điều hướng dưới */
@Composable
fun AppRoot(vm: MainVM = viewModel()) {
    val c = cv
    val ctx = LocalContext.current
    val snack = remember { SnackbarHostState() }
    LaunchedEffect(Unit) { vm.toasts.collect { snack.showSnackbar(it) } }
    LaunchedEffect(Unit) {
        if (System.currentTimeMillis() - Prefs.updCheckedAt > 6 * 3600_000L || Updater.latest == null) Updater.check()
        if (Updater.hasNew) Prefs.updNotified = Updater.latest!!.tag      // đã thấy trong app thì không gửi thông báo nữa
        YouTube.flushReports()
    }
    Box(Modifier.fillMaxSize().background(c.bg)) {
        Column(Modifier.fillMaxSize().imePadding()) {
            TopBar(vm)
            Box(Modifier.weight(1f)) {
                when (vm.tab) {
                    0 -> LibraryTab(vm)
                    1 -> OnlineTab(vm)
                    2 -> if (vm.paired) RemoteTab(vm) else PairScreen(vm, Modifier.fillMaxSize())
                    else -> SettingsTab(vm)
                }
            }
            Editor.busy?.let { label ->
                Column(Modifier.fillMaxWidth().background(c.surface2).padding(horizontal = 14.dp, vertical = 8.dp)) {
                    Text(label, color = c.text, fontWeight = FontWeight.Bold, fontSize = 14.sp)
                    Bar(Editor.progress, color = c.violet)
                }
            }
            MiniPlayer(onOpen = { vm.nowPlaying = true })
            BottomNav(vm)
        }
        if (vm.nowPlaying) NowPlaying(vm, onClose = { vm.nowPlaying = false })
        vm.playingVideo?.let { VideoScreen(it, onClose = { vm.playingVideo = null }) }
        vm.cutting?.let { CutScreen(vm, it) }
        if (vm.merging) MergeScreen(vm)
        SnackbarHost(snack, Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(bottom = 140.dp))
    }
}

@Composable
private fun TopBar(vm: MainVM) {
    val c = cv
    Column(Modifier.fillMaxWidth().background(c.cyan)) {
        Row(
            Modifier.statusBarsPadding().padding(horizontal = 16.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Logo(Modifier.size(34.dp))
            Text(
                listOf("Thư viện", "Nghe online", "Máy tính", "Cài đặt")[vm.tab.coerceIn(0, 3)],
                color = c.onAccent, fontWeight = FontWeight.Black, fontSize = 21.sp, modifier = Modifier.weight(1f),
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            if (vm.paired) {
                Text(
                    "● " + vm.pcName.ifBlank { "Máy tính" }, color = c.onAccent, fontSize = 12.sp, fontWeight = FontWeight.Bold,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 140.dp),
                )
            }
        }
        Box(Modifier.fillMaxWidth().height(2.5.dp).background(c.ink))
    }
}

@Composable
private fun BottomNav(vm: MainVM) {
    val c = cv
    val jobs by Downloads.jobs.collectAsState()
    val busy = jobs.count { it.state == JState.QUEUED || it.state == JState.RUNNING }
    val items = listOf(
        Triple("Thư viện", Ic.music, busy),
        Triple("Online", Ic.play, 0),
        Triple("Máy tính", Ic.download, 0),
        Triple("Cài đặt", Ic.settings, if (Updater.hasNew) 1 else 0),
    )
    Column(Modifier.fillMaxWidth().background(c.surface)) {
        Box(Modifier.fillMaxWidth().height(2.5.dp).background(c.ink))
        Row(Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 8.dp, vertical = 6.dp)) {
            items.forEachIndexed { i, (label, icon, badge) ->
                val on = vm.tab == i
                Column(
                    Modifier.weight(1f).clip(RoundedCornerShape(8.dp)).clickable { vm.tab = i }.padding(vertical = 4.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Box(
                        Modifier.then(if (on) Modifier.brutal(c.yellow, c.ink, shadow = 2.dp, radius = 14.dp, border = 2.dp) else Modifier)
                            .padding(horizontal = 16.dp, vertical = 3.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(icon, label, tint = if (on) c.onAccent else c.text, modifier = Modifier.size(22.dp))
                        if (badge > 0) {
                            Box(
                                Modifier.align(Alignment.TopEnd).offset(x = 12.dp, y = (-2).dp).size(16.dp).clip(CircleShape).background(c.red),
                                contentAlignment = Alignment.Center,
                            ) { Text(if (badge > 9) "9+" else "$badge", color = Color.White, fontSize = 9.sp, fontWeight = FontWeight.Bold) }
                        }
                    }
                    Text(label, color = c.text, fontSize = 12.sp, fontWeight = if (on) FontWeight.ExtraBold else FontWeight.Medium)
                }
            }
        }
    }
}

@Composable
internal fun Confirm(title: String, text: String, ok: String, onOk: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title, fontWeight = FontWeight.Black) },
        text = { Text(text) },
        confirmButton = { TextButton(onClick = { onOk(); onDismiss() }) { Text(ok, color = cv.red, fontWeight = FontWeight.Bold) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Thôi", color = cv.text) } },
        containerColor = cv.surface,
        titleContentColor = cv.text,
        textContentColor = cv.text,
        shape = androidx.compose.foundation.shape.RoundedCornerShape(8.dp),
    )
}

/* ------------------------------------------------------------------ ghép với máy tính */
@Composable
internal fun PairScreen(vm: MainVM, modifier: Modifier) {
    val c = cv
    val ctx = LocalContext.current
    var name by remember { mutableStateOf(Prefs.deviceName.ifBlank { MainVM.defaultName() }) }
    var addr by remember { mutableStateOf(Prefs.base.removePrefix("http://")) }
    var code by remember { mutableStateOf("") }
    Column(
        modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Card {
            H("Ghép với máy tính")
            Text(
                "Trên máy tính: mở CircleVault → tab Lưu Trữ → Mang theo điện thoại → Thêm thiết bị. Điện thoại phải dùng cùng Wi-Fi với máy tính.",
                color = c.text, fontSize = 15.sp, lineHeight = 21.sp,
            )
        }
        Field("Tên điện thoại này", name, { name = it.take(40) }, "Ví dụ: ĐT của Minh")
        BButton(
            if (vm.pairing) "Đang kết nối…" else "Quét mã QR trên máy tính", enabled = !vm.pairing, icon = Ic.qr,
            color = c.yellow, modifier = Modifier.fillMaxWidth(),
            onClick = {
                val opts = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
                GmsBarcodeScanning.getClient(ctx, opts).startScan()
                    .addOnSuccessListener { b ->
                        val p = MainVM.parsePair(b.rawValue ?: "")
                        if (p == null) vm.toast("Mã QR này không phải mã ghép CircleVault.")
                        else {
                            addr = p.first.removePrefix("http://"); code = p.second
                            vm.pair(p.first, p.second, name)
                        }
                    }
                    .addOnFailureListener {
                        vm.toast("Không mở được máy quét (${it.message ?: "lỗi"}). Hãy nhập tay bên dưới.")
                    }
            },
        )
        Hint("Hoặc nhập tay (địa chỉ và mã ghép hiện ngay dưới mã QR trên máy tính):")
        Field(
            "Địa chỉ máy tính", addr, { addr = it.trim() }, "192.168.1.5:8686",
            KeyboardOptions(keyboardType = KeyboardType.Uri),
        )
        Field(
            "Mã ghép", code, { code = it.uppercase().filter { ch -> ch.isLetterOrDigit() }.take(8) }, "8 ký tự",
            KeyboardOptions(capitalization = KeyboardCapitalization.Characters, keyboardType = KeyboardType.Ascii),
        )
        BButton(
            "Kết nối", enabled = !vm.pairing && addr.isNotBlank() && code.length == 8, modifier = Modifier.fillMaxWidth(),
            onClick = {
                val base = MainVM.normalizeAddr(addr)
                if (base == null) vm.toast("Địa chỉ chưa đúng. Ví dụ: 192.168.1.5:8686") else vm.pair(base, code, name)
            },
        )
    }
}

/* ------------------------------------------------------------------ tab Máy tính */
@Composable
private fun RemoteTab(vm: MainVM) {
    val c = cv
    val lib by Store.lib.collectAsState()
    val jobs by Downloads.jobs.collectAsState()
    val jobMap = jobs.associateBy { it.key }
    LaunchedEffect(vm.trackQ) {
        delay(350)
        if (vm.playlists != null) vm.searchTracks()
    }
    LaunchedEffect(vm.videoQ, vm.remoteKind) {
        if (vm.remoteKind == 1) {
            delay(350); vm.loadVideos(true)
        }
    }
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 12.dp, end = 12.dp, top = 12.dp, bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                BButton("♪ Nhạc", { vm.remoteKind = 0 }, Modifier.weight(1f), color = if (vm.remoteKind == 0) c.green else c.surface, small = true)
                BButton("▶ Phim & video", { vm.remoteKind = 1 }, Modifier.weight(1f), color = if (vm.remoteKind == 1) c.green else c.surface, small = true)
                IconBtn(Ic.refresh, "Tải lại", { vm.refresh() }, color = c.surface)
            }
        }
        vm.remoteErr?.let { err ->
            item {
                Card(color = c.surface2) {
                    Text(err, color = c.red, fontWeight = FontWeight.Bold)
                    if (vm.revoked) {
                        BButton("Ghép lại", { vm.unpair() }, color = c.yellow, small = true)
                    } else {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            BButton("Thử lại", { vm.refresh() }, color = c.yellow, small = true)
                            if (!lib.empty) BButton("Xem đồ đã tải", { vm.tab = 0 }, color = c.surface, small = true)
                        }
                    }
                }
            }
        }
        if (vm.loading && vm.playlists == null) item { Hint("Đang kết nối máy tính…") }

        if (vm.remoteKind == 0) {
            val pls = vm.playlists
            if (pls != null) {
                item { H("Playlist") }
                if (pls.isEmpty()) item { Hint("Máy tính chưa có playlist nào. Tạo ở tab Nghe Nhạc trên máy tính, hoặc tìm bài lẻ bên dưới.") }
                items(pls, key = { "p" + it.id }) { p -> RemotePlaylistCard(vm, p, lib, jobMap) }
                item {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        H("Tìm bài lẻ")
                        Field("", vm.trackQ, { vm.trackQ = it }, "Tên bài, ca sĩ…")
                        if (vm.trackQ.isBlank()) Hint("Bài mới thêm gần đây:")
                    }
                }
                items(vm.trackRes, key = { "s" + it.id }) { t ->
                    Box(Modifier.fillMaxWidth().brutal(c.surface, c.ink, shadow = 2.dp, border = 2.dp).padding(horizontal = 12.dp)) {
                        RemoteTrackRow(vm, t, lib.tracks.containsKey(t.id), jobMap["t${t.id}"], 0)
                    }
                }
            }
        } else {
            item { Field("", vm.videoQ, { vm.videoQ = it }, "Tìm phim, video…") }
            val vs = vm.videos
            if (vs == null) item { Hint("Đang tải danh sách…") }
            else if (vs.isEmpty()) item { Hint(if (vm.videoQ.isBlank()) "Thư viện trên máy tính chưa có phim hay video nào." else "Không thấy video nào khớp.") }
            else {
                items(vs, key = { "v" + it.id }) { v -> RemoteVideoCard(vm, v, lib.videos.containsKey(v.id), jobMap["v${v.id}"]) }
                if (vm.videosMore) item { BButton("Xem thêm", { vm.loadVideos(false) }, Modifier.fillMaxWidth(), color = c.surface) }
            }
        }
    }
}

@Composable
internal fun JobBadge(job: DJob?, have: Boolean, onDownload: () -> Unit) {
    val c = cv
    val ctx = LocalContext.current
    when {
        have -> Box(Modifier.size(46.dp), contentAlignment = Alignment.Center) { Icon(Ic.check, "Đã có", tint = Color(0xFF1C9E5C)) }
        job?.state == JState.QUEUED -> Box(Modifier.size(46.dp), contentAlignment = Alignment.Center) { Text("chờ", color = c.muted, fontSize = 12.sp) }
        job?.state == JState.RUNNING -> Box(Modifier.size(46.dp), contentAlignment = Alignment.Center) {
            Text(if (job.total > 0) "${job.done * 100 / job.total}%" else "…", color = c.text, fontWeight = FontWeight.Bold, fontSize = 13.sp)
        }
        job?.state == JState.ERROR -> IconBtn(Ic.refresh, "Thử lại", { Downloads.retry(ctx, job.key) }, color = c.red)
        else -> IconBtn(Ic.download, "Tải về", onDownload)
    }
}

@Composable
private fun RemoteTrackRow(vm: MainVM, t: RTrack, have: Boolean, job: DJob?, n: Int) {
    val c = cv
    Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text((if (n > 0) "$n. " else "") + t.title, color = c.text, fontWeight = FontWeight.Bold, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Hint(listOfNotNull(t.artist, fmtDur(t.duration).ifBlank { null }, fmtBytes(t.size)).joinToString(" · "))
        }
        Spacer(Modifier.width(8.dp))
        JobBadge(job, have) { vm.downloadTracks(listOf(t)) }
    }
}

@Composable
private fun RemotePlaylistCard(vm: MainVM, p: RPlaylist, lib: vn.circlevault.app.Library, jobs: Map<String, DJob>) {
    val c = cv
    val open = vm.opened.containsKey(p.id)
    val detail = vm.opened[p.id]
    val local = lib.playlists.find { it.id == p.id }
    val haveAll = local != null && local.trackIds.size == p.count && local.trackIds.all { it in lib.tracks }
    Card {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Box(Modifier.brutal(c.yellow, c.ink, shadow = 0.dp, border = 2.dp).size(48.dp), contentAlignment = Alignment.Center) {
                Icon(Ic.music, null, tint = c.onAccent)
            }
            Column(Modifier.weight(1f)) {
                Text(p.name, color = c.text, fontWeight = FontWeight.ExtraBold, fontSize = 16.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Hint("${p.count} bài · ${fmtBytes(p.size)}" + if (haveAll) " · ✓ đã có trên điện thoại" else "")
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (p.count > 0) {
                BButton(if (haveAll) "Cập nhật" else "Tải playlist", { vm.downloadPlaylist(p) }, Modifier.weight(1f), icon = Ic.download)
            }
            BButton(if (open) "Ẩn bài" else "Xem bài", { vm.toggle(p.id) }, Modifier.weight(1f), color = c.surface, icon = if (open) Ic.up else Ic.down)
        }
        if (open) {
            if (detail == null) Hint("Đang tải…")
            else detail.tracks.forEachIndexed { i, t -> RemoteTrackRow(vm, t, t.id in lib.tracks, jobs["t${t.id}"], i + 1) }
        }
    }
}

@Composable
private fun RemoteVideoCard(vm: MainVM, v: RVideo, have: Boolean, job: DJob?) {
    val c = cv
    Card {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Thumb(v.thumb, Ic.movie)
            Column(Modifier.weight(1f)) {
                Text(v.title, color = c.text, fontWeight = FontWeight.Bold, maxLines = 3, overflow = TextOverflow.Ellipsis)
                Hint(listOfNotNull(fmtDur(v.duration).ifBlank { null }, if (v.height > 0) "${v.height}p" else null, fmtBytes(v.size)).joinToString(" · "))
            }
            JobBadge(job, have) { vm.downloadVideo(v) }
        }
        if (job?.state == JState.RUNNING && job.total > 0) Bar(job.done.toFloat() / job.total)
    }
}

@Composable
internal fun Thumb(src: Any?, fallback: androidx.compose.ui.graphics.vector.ImageVector, size: Int = 0) {
    val c = cv
    val mod = if (size > 0) Modifier.size(size.dp) else Modifier.width(96.dp).height(54.dp)
    Box(mod.brutal(c.surface2, c.ink, shadow = 0.dp, radius = 4.dp, border = 2.dp), contentAlignment = Alignment.Center) {
        Icon(fallback, null, tint = c.muted)
        if (src != null) {
            AsyncImage(
                model = ImageRequest.Builder(LocalContext.current).data(src).crossfade(true).build(),
                contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize(),
            )
        }
    }
}
