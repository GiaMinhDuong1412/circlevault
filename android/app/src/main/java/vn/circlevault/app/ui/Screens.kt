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

/* ------------------------------------------------------------------ khung app */
@Composable
fun AppRoot(vm: MainVM = viewModel()) {
    val c = cv
    val snack = remember { SnackbarHostState() }
    LaunchedEffect(Unit) { vm.toasts.collect { snack.showSnackbar(it) } }
    Box(Modifier.fillMaxSize().background(c.bg)) {
        Column(Modifier.fillMaxSize().imePadding()) {
            TopBar(vm)
            if (!vm.paired) {
                PairScreen(vm, Modifier.weight(1f))
            } else {
                Tabs(vm.tab) { vm.tab = it }
                Box(Modifier.weight(1f)) {
                    when (vm.tab) {
                        0 -> RemoteTab(vm)
                        1 -> PhoneTab(vm)
                        else -> SettingsTab(vm)
                    }
                }
            }
            MiniPlayer(onOpen = { vm.nowPlaying = true })
            Spacer(Modifier.navigationBarsPadding())
        }
        if (vm.nowPlaying) NowPlaying(onClose = { vm.nowPlaying = false })
        vm.playingVideo?.let { VideoScreen(it, onClose = { vm.playingVideo = null }) }
        SnackbarHost(snack, Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(bottom = 76.dp))
    }
}

@Composable
private fun TopBar(vm: MainVM) {
    val c = cv
    Column(Modifier.fillMaxWidth().background(c.cyan)) {
        Row(
            Modifier.statusBarsPadding().padding(horizontal = 16.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Logo()
            Column(Modifier.weight(1f)) {
                Text("CIRCLEVAULT", color = c.onAccent, fontWeight = FontWeight.ExtraBold, fontSize = 12.sp, letterSpacing = 1.sp)
                Text(
                    if (vm.paired) "Mang theo · ${vm.pcName.ifBlank { "Máy tính" }}" else "Mang theo điện thoại",
                    color = c.onAccent, fontWeight = FontWeight.Black, fontSize = 19.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
        }
        Box(Modifier.fillMaxWidth().height(2.5.dp).background(c.ink))
    }
}

@Composable
private fun Tabs(tab: Int, onTab: (Int) -> Unit) {
    val c = cv
    val jobs by Downloads.jobs.collectAsState()
    val busy = jobs.count { it.state == JState.QUEUED || it.state == JState.RUNNING }
    Row(Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, top = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        listOf("Máy tính", if (busy > 0) "Điện thoại ($busy)" else "Điện thoại", "Cài đặt").forEachIndexed { i, t ->
            Box(
                Modifier.weight(1f)
                    .brutal(if (tab == i) c.yellow else c.surface, c.ink, shadow = 3.dp, radius = 6.dp, border = 2.dp)
                    .clickable { onTab(i) }
                    .height(46.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(t, color = if (tab == i) c.onAccent else c.text, fontWeight = FontWeight.ExtraBold, fontSize = 14.5.sp, maxLines = 1)
            }
        }
    }
}

@Composable
private fun Confirm(title: String, text: String, ok: String, onOk: () -> Unit, onDismiss: () -> Unit) {
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
private fun PairScreen(vm: MainVM, modifier: Modifier) {
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
                            if (!lib.empty) BButton("Xem đồ đã tải", { vm.tab = 1 }, color = c.surface, small = true)
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
private fun JobBadge(job: DJob?, have: Boolean, onDownload: () -> Unit) {
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
private fun Thumb(src: Any?, fallback: androidx.compose.ui.graphics.vector.ImageVector, size: Int = 0) {
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

/* ------------------------------------------------------------------ tab Điện thoại */
@Composable
private fun PhoneTab(vm: MainVM) {
    val c = cv
    val ctx = LocalContext.current
    val lib by Store.lib.collectAsState()
    val jobs by Downloads.jobs.collectAsState()
    val active by Downloads.active.collectAsState()
    var ask by remember { mutableStateOf<Triple<String, String, () -> Unit>?>(null) }
    var openPl by remember { mutableStateOf(setOf<Int>()) }
    val vol = remember(lib, jobs.size) { Store.current() }
    val allTracks = lib.tracks.values.reversed()
    val ps = rememberPState()

    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 12.dp, end = 12.dp, top = 12.dp, bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item {
            Card(color = c.surface2) {
                Text("Đang lưu ở ${vol.label}", color = c.text, fontWeight = FontWeight.Bold)
                Hint("CircleVault đang dùng ${fmtBytes(lib.bytes)} · còn trống ${fmtBytes(vol.free)} / ${fmtBytes(vol.total)}")
                Bar(if (vol.total > 0) 1f - vol.free.toFloat() / vol.total else 0f, color = c.cyan)
            }
        }
        val pending = jobs.filter { it.state != JState.DONE }
        if (pending.isNotEmpty()) {
            item {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    H("Đang tải (${pending.size})", Modifier.weight(1f))
                    if (pending.any { it.state == JState.QUEUED } && !active) BButton("Tiếp tục", { Downloads.resume(ctx) }, small = true, color = c.yellow)
                    Spacer(Modifier.width(8.dp))
                    if (pending.any { it.state == JState.ERROR }) BButton("Bỏ file lỗi", { Downloads.clearFinished() }, small = true, color = c.surface)
                }
            }
            items(jobs.filter { it.state != JState.DONE }.take(60), key = { "j" + it.key }) { j -> JobRow(j) }
        }
        if (lib.empty && jobs.isEmpty()) {
            item {
                Card {
                    H("Chưa có gì trên điện thoại")
                    Text("Vào tab Máy tính, chọn playlist hay phim rồi bấm Tải. Tải xong thì tắt máy tính vẫn nghe, xem được.", color = c.text)
                    BButton("Mở tab Máy tính", { vm.tab = 0 }, small = true)
                }
            }
        }
        if (lib.playlists.isNotEmpty()) {
            item { H("Playlist") }
            items(lib.playlists, key = { "op" + it.id }) { p ->
                val tracks = p.trackIds.mapNotNull { lib.tracks[it] }
                val open = p.id in openPl
                Card {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Column(Modifier.weight(1f).clickable { openPl = if (open) openPl - p.id else openPl + p.id }) {
                            Text(p.name, color = c.text, fontWeight = FontWeight.ExtraBold, fontSize = 16.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            Hint("${tracks.size}/${p.trackIds.size} bài đã tải · ${fmtBytes(tracks.sumOf { it.size })}" + if (open) " · ▴" else " · ▾ xem bài")
                        }
                        IconBtn(Ic.play, "Phát", { PlayerConn.play(tracks, 0) }, color = c.green, enabled = tracks.isNotEmpty())
                        IconBtn(Ic.delete, "Xóa", {
                            ask = Triple(
                                "Xóa playlist \"${p.name}\"?",
                                "Xóa khỏi điện thoại các bài của playlist này (bài nằm trong playlist khác được giữ lại). Trên máy tính không mất gì.",
                            ) { Store.deletePlaylist(p.id) }
                        }, color = c.surface)
                    }
                    if (open) tracks.forEachIndexed { i, t -> LocalTrackRow(t, ps.mediaId, onPlay = { PlayerConn.play(tracks, i) }, onDelete = null) }
                }
            }
        }
        if (allTracks.isNotEmpty()) {
            item {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    H("Tất cả bài hát (${allTracks.size})", Modifier.weight(1f))
                    BButton("Phát hết", { PlayerConn.play(allTracks, 0) }, small = true, icon = Ic.play)
                }
            }
            items(allTracks, key = { "ot" + it.id }) { t ->
                Box(Modifier.fillMaxWidth().brutal(c.surface, c.ink, shadow = 2.dp, border = 2.dp).padding(horizontal = 12.dp)) {
                    LocalTrackRow(t, ps.mediaId, onPlay = { PlayerConn.play(allTracks, allTracks.indexOf(t)) }, onDelete = {
                        ask = Triple("Xóa \"${t.title}\"?", "Chỉ xóa trên điện thoại, máy tính vẫn còn.") { Store.deleteTrack(t.id) }
                    })
                }
            }
        }
        if (lib.videos.isNotEmpty()) {
            item { H("Phim & video (${lib.videos.size})") }
            items(lib.videos.values.reversed(), key = { "ov" + it.id }) { v ->
                Card {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Box(Modifier.clickable { vm.playingVideo = v }) { Thumb(v.thumb?.let { File(it) }, Ic.movie) }
                        Column(Modifier.weight(1f).clickable { vm.playingVideo = v }) {
                            Text(v.title, color = c.text, fontWeight = FontWeight.Bold, maxLines = 3, overflow = TextOverflow.Ellipsis)
                            Hint(listOfNotNull(fmtDur(v.duration).ifBlank { null }, fmtBytes(v.size)).joinToString(" · "))
                        }
                        IconBtn(Ic.delete, "Xóa", {
                            ask = Triple("Xóa \"${v.title}\"?", "Chỉ xóa trên điện thoại, máy tính vẫn còn.") { Store.deleteVideo(v.id) }
                        }, color = c.surface)
                    }
                }
            }
        }
        if (!lib.empty) {
            item {
                BButton("Xóa hết để tải đợt mới", {
                    ask = Triple(
                        "Xóa hết nhạc, phim trên điện thoại?",
                        "Xóa toàn bộ ${fmtBytes(lib.bytes)} đã tải về điện thoại. Trên máy tính không mất gì, lúc nào cũng tải lại được.",
                    ) { PlayerConn.controller?.clearMediaItems(); Store.deleteAll() }
                }, Modifier.fillMaxWidth(), color = c.red, icon = Ic.delete)
            }
        }
    }
    ask?.let { (t, m, f) -> Confirm(t, m, "Xóa", f) { ask = null } }
}

@Composable
private fun JobRow(j: DJob) {
    val c = cv
    val ctx = LocalContext.current
    Box(Modifier.fillMaxWidth().brutal(c.surface, c.ink, shadow = 2.dp, border = 2.dp).padding(12.dp)) {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(j.title, color = c.text, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Hint(
                        when (j.state) {
                            JState.QUEUED -> "Chờ tải · ${fmtBytes(j.total)}"
                            JState.RUNNING -> "${fmtBytes(j.done)} / ${fmtBytes(j.total)}"
                            JState.ERROR -> j.error ?: "Lỗi"
                            JState.DONE -> "Xong"
                        },
                        color = if (j.state == JState.ERROR) c.red else c.muted,
                    )
                }
                if (j.state == JState.ERROR) {
                    IconBtn(Ic.refresh, "Thử lại", { Downloads.retry(ctx, j.key) }, color = c.yellow)
                    Spacer(Modifier.width(8.dp))
                }
                IconBtn(Ic.close, "Hủy", { Downloads.cancel(j.key) }, color = c.surface)
            }
            if (j.state == JState.RUNNING) Bar(if (j.total > 0) j.done.toFloat() / j.total else 0f)
        }
    }
}

@Composable
private fun LocalTrackRow(t: OTrack, playingId: String?, onPlay: () -> Unit, onDelete: (() -> Unit)?) {
    val c = cv
    val playing = playingId == "t${t.id}"
    Row(Modifier.fillMaxWidth().clickable(onClick = onPlay).padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Thumb(t.cover?.let { File(it) }, Ic.music, size = 44)
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(t.title, color = if (playing) Color(0xFF0E8FB3) else c.text, fontWeight = FontWeight.Bold, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Hint(listOfNotNull(t.artist, fmtDur(t.duration).ifBlank { null }, fmtBytes(t.size)).joinToString(" · "))
        }
        if (onDelete != null) IconBtn(Ic.delete, "Xóa", onDelete, color = c.surface)
    }
}

/* ------------------------------------------------------------------ tab Cài đặt */
@Composable
private fun SettingsTab(vm: MainVM) {
    val c = cv
    val ctx = LocalContext.current
    var vol by remember { mutableStateOf(Prefs.volume) }
    var ask by remember { mutableStateOf(false) }
    val vols = remember { Store.volumes() }
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
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
            if (vols.size < 2) Hint("Không thấy thẻ nhớ. Nếu điện thoại có lắp thẻ, hãy kiểm tra thẻ đã được nhận trong Cài đặt → Bộ nhớ.")
            Hint("Đổi nơi lưu chỉ áp dụng cho lần tải sau, đồ đã tải vẫn ở chỗ cũ. Gỡ app thì nhạc, phim đã tải trong app cũng bị xóa (cập nhật app thì không).")
        }
        Card {
            H("Máy tính đã ghép")
            Text(vm.pcName.ifBlank { "Máy tính" }, color = c.text, fontWeight = FontWeight.Bold)
            Hint("${Prefs.base.removePrefix("http://")} · điện thoại này: ${Prefs.deviceName.ifBlank { MainVM.defaultName() }}")
            BButton("Ghép lại / đổi máy tính", { ask = true }, color = c.surface, small = true)
        }
        Card {
            H("Về app")
            Hint("CircleVault cho Android, bản ${BuildConfig.VERSION_NAME}. Chỉ dùng trong nhà: tải từ máy tính của bạn qua Wi-Fi, nghe/xem offline.")
        }
    }
    if (ask) {
        Confirm(
            "Ghép lại với máy tính?", "Điện thoại sẽ ngắt kết nối với máy tính hiện tại, rồi bạn quét mã ghép mới. Nhạc, phim đã tải vẫn giữ nguyên.",
            "Ngắt kết nối", { vm.unpair() },
        ) { ask = false }
    }
}
