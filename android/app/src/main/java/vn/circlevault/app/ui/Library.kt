package vn.circlevault.app.ui

import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.annotation.OptIn
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.RangeSlider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.media3.common.MediaItem
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import coil.compose.AsyncImage
import kotlinx.coroutines.delay
import vn.circlevault.app.DJob
import vn.circlevault.app.Downloads
import vn.circlevault.app.Editor
import vn.circlevault.app.JState
import vn.circlevault.app.MainVM
import vn.circlevault.app.OTrack
import vn.circlevault.app.PlayerConn
import vn.circlevault.app.Store
import vn.circlevault.app.Updater
import vn.circlevault.app.fmtBytes
import vn.circlevault.app.fmtDur
import java.io.File

private val FILTERS = listOf("Tất cả", "Playlist", "Bài hát", "Phim", "Cắt / ghép")

/* ------------------------------------------------------------------ tab Thư viện (nhạc, phim trên điện thoại) */
@Composable
fun LibraryTab(vm: MainVM) {
    val c = cv
    val ctx = LocalContext.current
    val lib by Store.lib.collectAsState()
    val jobs by Downloads.jobs.collectAsState()
    val active by Downloads.active.collectAsState()
    var ask by remember { mutableStateOf<Triple<String, String, () -> Unit>?>(null) }
    var filter by remember { mutableStateOf(0) }
    var openPl by remember { mutableStateOf<Int?>(null) }
    val vol = remember(lib, jobs.size) { Store.current() }
    val ps = rememberPState()
    val allTracks = lib.tracks.values.reversed()
    val pending = jobs.filter { it.state != JState.DONE }
    val sel = vm.selecting

    BackHandler(enabled = sel.isNotEmpty() || openPl != null) {
        if (sel.isNotEmpty()) vm.selecting = emptyList() else openPl = null
    }

    Column(Modifier.fillMaxSize()) {
        if (sel.isNotEmpty()) {
            Row(
                Modifier.fillMaxWidth().background(c.violet).padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text("Đã chọn ${sel.size} bài", color = c.onAccent, fontWeight = FontWeight.ExtraBold, modifier = Modifier.weight(1f))
                BButton("Ghép", { if (sel.size < 2) vm.toast("Chọn ít nhất 2 bài để ghép.") else vm.merging = true }, small = true, icon = Ic.merge, color = c.yellow)
                IconBtn(Ic.close, "Bỏ chọn", { vm.selecting = emptyList() }, color = c.surface)
            }
        }
        LazyColumn(
            Modifier.fillMaxSize(),
            contentPadding = PaddingValues(start = 12.dp, end = 12.dp, top = 12.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (Updater.showBanner) {
                item {
                    Card(color = c.green) {
                        Text("Có bản mới ${Updater.latest?.version}", color = c.onAccent, fontWeight = FontWeight.Black, fontSize = 16.sp)
                        Text("Cập nhật không mất nhạc, phim đã tải.", color = c.onAccent, fontSize = 13.5.sp)
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            BButton("Cập nhật", { vm.tab = 3 }, small = true, color = c.yellow)
                            BButton("Để sau", { Updater.later(); vm.toast("Xem lại ở tab Cài đặt khi muốn cập nhật.") }, small = true, color = c.surface)
                        }
                    }
                }
            }
            item {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Column(Modifier.weight(1f)) {
                        Text("${lib.tracks.size} bài · ${lib.videos.size} phim", color = c.text, fontWeight = FontWeight.Black, fontSize = 18.sp)
                        Hint("${fmtBytes(lib.bytes)} trên ${vol.label} · còn trống ${fmtBytes(vol.free)}")
                    }
                    if (allTracks.isNotEmpty()) BButton("Phát", { PlayerConn.play(allTracks.shuffled(), 0) }, small = true, icon = Ic.play)
                }
            }
            item {
                LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    itemsIndexed(FILTERS) { i, f ->
                        Box(
                            Modifier.brutal(if (filter == i) c.ink else c.surface, c.ink, shadow = 0.dp, radius = 18.dp, border = 2.dp)
                                .clickable { filter = i; openPl = null }.padding(horizontal = 14.dp, vertical = 7.dp),
                        ) { Text(f, color = if (filter == i) c.bg else c.text, fontWeight = FontWeight.Bold, fontSize = 14.sp) }
                    }
                }
            }
            if (pending.isNotEmpty()) {
                item {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        H("Đang tải (${pending.size})", Modifier.weight(1f), size = 16)
                        if (pending.any { it.state == JState.QUEUED } && !active) BButton("Tiếp tục", { Downloads.resume(ctx) }, small = true, color = c.yellow)
                        Spacer(Modifier.width(8.dp))
                        if (pending.any { it.state == JState.ERROR }) BButton("Bỏ file lỗi", { Downloads.clearFinished() }, small = true, color = c.surface)
                    }
                }
                items(pending.take(40), key = { "j" + it.key }) { j -> JobRow(j) }
            }
            if (lib.empty && pending.isEmpty()) {
                item {
                    Card {
                        H("Chưa có gì trên điện thoại")
                        Text("Tải từ máy tính ở tab Máy tính, hoặc nghe và lưu bài từ YouTube ở tab Online.", color = c.text)
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            BButton("Máy tính", { vm.tab = 2 }, small = true)
                            BButton("Online", { vm.tab = 1 }, small = true, color = c.yellow)
                        }
                    }
                }
            }

            // ---- playlist: thẻ 2 cột (chạm để mở)
            val pls = lib.playlists
            val open = openPl?.let { id -> pls.find { it.id == id } }
            if ((filter == 0 || filter == 1) && pls.isNotEmpty() && open == null) {
                item { H("Playlist", size = 16) }
                items(pls.chunked(2), key = { row -> "pr" + row.joinToString { it.id.toString() } }) { row ->
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        row.forEach { p ->
                            val tr = p.trackIds.mapNotNull { lib.tracks[it] }
                            val newN = vm.playlists?.find { it.id == p.id }?.let { vm.plSync(it, lib).missing } ?: 0
                            PlaylistTile(p.name, "${tr.size} bài" + if (newN > 0) " · +$newN mới" else "", tr.firstNotNullOfOrNull { it.cover }, Modifier.weight(1f)) { openPl = p.id }
                        }
                        if (row.size == 1) Spacer(Modifier.weight(1f))
                    }
                }
            }
            if (open != null) {
                val tracks = open.trackIds.mapNotNull { lib.tracks[it] }
                item {
                    Card {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            IconBtn(Ic.back, "Quay lại", { openPl = null }, color = c.surface)
                            Column(Modifier.weight(1f)) {
                                Text(open.name, color = c.text, fontWeight = FontWeight.Black, fontSize = 18.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                                Hint("${tracks.size}/${open.trackIds.size} bài đã tải · ${fmtBytes(tracks.sumOf { it.size })}")
                            }
                        }
                        val remote = vm.playlists?.find { it.id == open.id }
                        if (remote != null) {
                            val sync = vm.plSync(remote, lib)
                            if (sync.missing > 0) Text("Máy tính có ${sync.missing} bài mới trong playlist này.", color = c.red, fontWeight = FontWeight.Bold, fontSize = 13.sp)
                            BButton(if (sync.missing > 0) "Cập nhật từ máy tính +${sync.missing}" else "Cập nhật từ máy tính", { vm.downloadPlaylist(remote) },
                                Modifier.fillMaxWidth(), color = if (sync.missing > 0) c.green else c.surface, icon = Ic.refresh)
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            BButton("Phát", { PlayerConn.play(tracks, 0) }, Modifier.weight(1f), icon = Ic.play, enabled = tracks.isNotEmpty())
                            BButton("Trộn", { PlayerConn.play(tracks.shuffled(), 0) }, Modifier.weight(1f), color = c.surface, enabled = tracks.isNotEmpty())
                            BButton("☁", { vm.uploadDrive(tracks, open.name) }, color = c.surface, enabled = tracks.isNotEmpty())
                            IconBtn(Ic.delete, "Xóa playlist", {
                                ask = Triple(
                                    "Xóa playlist \"${open.name}\"?",
                                    "Xóa khỏi điện thoại các bài của playlist này (bài nằm trong playlist khác được giữ). Máy tính không mất gì.",
                                ) { Store.deletePlaylist(open.id); openPl = null }
                            }, color = c.surface)
                        }
                    }
                }
                itemsIndexed(tracks, key = { _, t -> "opt" + t.id }) { i, t ->
                    TrackCard(vm, t, ps.mediaId, onPlay = { PlayerConn.play(tracks, i) }, onDelete = null)
                }
            }

            // ---- bài hát
            val songs = when (filter) {
                0, 2 -> if (open == null) allTracks else emptyList()
                4 -> allTracks.filter { it.local && it.yt == null }
                else -> emptyList()
            }
            if (songs.isNotEmpty()) {
                item { H(if (filter == 4) "Bài đã cắt / ghép" else "Bài hát", size = 16) }
                itemsIndexed(songs, key = { _, t -> "ot" + t.id }) { i, t ->
                    TrackCard(vm, t, ps.mediaId, onPlay = { PlayerConn.play(songs, i) }, onDelete = {
                        ask = Triple("Xóa \"${t.title}\"?", "Chỉ xóa trên điện thoại.") { Store.deleteTrack(t.id) }
                    })
                }
            }
            if (filter == 4 && songs.isEmpty()) item { Hint("Chưa có bài nào. Bấm ⋮ ở một bài → Cắt đoạn, hoặc Chọn để ghép nhiều bài.") }

            // ---- phim
            if ((filter == 0 || filter == 3) && open == null && lib.videos.isNotEmpty()) {
                item { H("Phim & video", size = 16) }
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
            if (!lib.empty && filter == 0 && open == null) {
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
    }
    ask?.let { (t, m, f) -> Confirm(t, m, "Xóa", f) { ask = null } }
}

@Composable
private fun PlaylistTile(name: String, sub: String, cover: String?, modifier: Modifier, onClick: () -> Unit) {
    val c = cv
    val tint = listOf(c.yellow, c.pink, c.cyan, c.green, c.violet)[Math.floorMod(name.hashCode(), 5)]
    Column(modifier.brutal(c.surface, c.ink).clickable(onClick = onClick)) {
        Box(Modifier.fillMaxWidth().aspectRatio(1.4f).background(Brush.linearGradient(listOf(tint, c.surface2))), contentAlignment = Alignment.Center) {
            Icon(Ic.music, null, tint = c.onAccent, modifier = Modifier.size(40.dp))
            if (cover != null) AsyncImage(File(cover), null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        }
        Box(Modifier.fillMaxWidth().background(c.ink).size(width = 1.dp, height = 2.dp))
        Column(Modifier.padding(10.dp)) {
            Text(name, color = c.text, fontWeight = FontWeight.ExtraBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(sub, color = c.muted, fontSize = 12.5.sp)
        }
    }
}

@Composable
internal fun JobRow(j: DJob) {
    val c = cv
    val ctx = LocalContext.current
    Box(Modifier.fillMaxWidth().brutal(c.surface, c.ink, shadow = 2.dp, border = 2.dp).padding(12.dp)) {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(j.title, color = c.text, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Hint(
                        when (j.state) {
                            JState.QUEUED -> "Chờ tải" + if (j.total > 0) " · ${fmtBytes(j.total)}" else ""
                            JState.RUNNING -> "${fmtBytes(j.done)} / ${if (j.total > 0) fmtBytes(j.total) else "?"}"
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

/** một bài trên điện thoại: chạm để phát, ⋮ để cắt / chọn ghép / xóa; đang chọn ghép thì chạm để chọn */
@Composable
private fun TrackCard(vm: MainVM, t: OTrack, playingId: String?, onPlay: () -> Unit, onDelete: (() -> Unit)?) {
    val c = cv
    val playing = playingId == "t${t.id}" || (t.yt != null && playingId == "y${t.yt}")
    val selected = t.id in vm.selecting
    var menu by remember { mutableStateOf(false) }
    Row(
        Modifier.fillMaxWidth()
            .brutal(if (selected) c.violet else c.surface, c.ink, shadow = 2.dp, border = 2.dp)
            .clickable { if (vm.selecting.isNotEmpty()) vm.toggleSelect(t.id) else onPlay() }
            .padding(start = 10.dp, end = 4.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Thumb(t.cover?.let { File(it) }, Ic.music, size = 46)
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(
                (if (playing) "▶ " else "") + t.title, color = if (playing) c.text else c.text,
                fontWeight = if (playing) FontWeight.Black else FontWeight.Bold, maxLines = 2, overflow = TextOverflow.Ellipsis,
            )
            Hint(
                listOfNotNull(
                    t.artist, fmtDur(t.duration).ifBlank { null }, fmtBytes(t.size),
                    if (t.yt != null) "YouTube" else if (t.local) "cắt/ghép" else null,
                ).joinToString(" · "),
            )
        }
        Box {
            Box(Modifier.size(44.dp).clickable { menu = true }, contentAlignment = Alignment.Center) {
                Icon(Ic.more, "Thêm", tint = c.text)
            }
            DropdownMenu(menu, { menu = false }, containerColor = c.surface) {
                DropdownMenuItem({ Text("Phát") }, { menu = false; onPlay() })
                DropdownMenuItem({ Text("Cắt đoạn") }, { menu = false; vm.cutting = t })
                DropdownMenuItem({ Text(if (selected) "Bỏ chọn ghép" else "Chọn để ghép") }, { menu = false; vm.toggleSelect(t.id) })
                DropdownMenuItem({ Text("Lưu lên Google Drive") }, { menu = false; vm.uploadDrive(listOf(t), null) })
                if (onDelete != null) DropdownMenuItem({ Text("Xóa khỏi điện thoại", color = c.red) }, { menu = false; onDelete() })
            }
        }
    }
}

/* ------------------------------------------------------------------ cắt đoạn */
@OptIn(UnstableApi::class)
@Composable
fun CutScreen(vm: MainVM, t: OTrack) {
    val c = cv
    val ctx = LocalContext.current
    val total = (t.duration * 1000).toLong().coerceAtLeast(1000)
    var range by remember { mutableStateOf(0f..total.toFloat()) }
    var name by remember { mutableStateOf("${t.title} (cắt)") }
    var previewing by remember { mutableStateOf(false) }
    val preview = remember { ExoPlayer.Builder(ctx).build().apply { setMediaItem(MediaItem.fromUri(Uri.fromFile(File(t.path)))); prepare() } }
    DisposableEffect(Unit) { onDispose { preview.release() } }
    LaunchedEffect(previewing, range) {
        if (previewing) {
            PlayerConn.controller?.pause()
            preview.seekTo(range.start.toLong()); preview.play()
            while (previewing && preview.currentPosition < range.endInclusive) delay(100)
            preview.pause(); previewing = false
        } else preview.pause()
    }
    BackHandler { vm.cutting = null }
    val ms = { v: Float -> fmtDur(v / 1000.0).ifBlank { "0:00" } + ".${((v % 1000) / 100).toInt()}" }
    Column(
        Modifier.fillMaxSize().background(c.bg).statusBarsPadding().navigationBarsPadding().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            IconBtn(Ic.back, "Đóng", { vm.cutting = null }, color = c.surface)
            H("Cắt đoạn", size = 20)
        }
        Card {
            Text(t.title, color = c.text, fontWeight = FontWeight.Bold)
            Hint("Dài ${fmtDur(t.duration)} · kéo 2 đầu để chọn đoạn giữ lại. File gốc giữ nguyên, đoạn cắt thành bài mới.")
            RangeSlider(
                value = range, onValueChange = { range = it }, valueRange = 0f..total.toFloat(),
                colors = SliderDefaults.colors(thumbColor = c.ink, activeTrackColor = c.cyan, inactiveTrackColor = c.surface2),
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) { Hint("Từ"); Text(ms(range.start), color = c.text, fontWeight = FontWeight.Black, fontSize = 18.sp) }
                Column(Modifier.weight(1f)) { Hint("Đến"); Text(ms(range.endInclusive), color = c.text, fontWeight = FontWeight.Black, fontSize = 18.sp) }
                Column(Modifier.weight(1f)) { Hint("Độ dài"); Text(ms(range.endInclusive - range.start), color = c.text, fontWeight = FontWeight.Black, fontSize = 18.sp) }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Đầu", color = c.text, fontWeight = FontWeight.Bold, fontSize = 13.sp)
                listOf("−1s" to -1000f, "+1s" to 1000f).forEach { (l, d) ->
                    BButton(l, { range = (range.start + d).coerceIn(0f, range.endInclusive - 500f)..range.endInclusive }, Modifier.weight(1f), small = true, color = c.surface)
                }
                Spacer(Modifier.width(6.dp))
                Text("Cuối", color = c.text, fontWeight = FontWeight.Bold, fontSize = 13.sp)
                listOf("−1s" to -1000f, "+1s" to 1000f).forEach { (l, d) ->
                    BButton(l, { range = range.start..(range.endInclusive + d).coerceIn(range.start + 500f, total.toFloat()) }, Modifier.weight(1f), small = true, color = c.surface)
                }
            }
            BButton(if (previewing) "Dừng nghe thử" else "Nghe thử đoạn này", { previewing = !previewing }, Modifier.fillMaxWidth(), color = c.yellow, icon = if (previewing) Ic.pause else Ic.play)
        }
        Field("Tên bài mới", name, { name = it.take(80) })
        BButton(
            if (Editor.busy != null) "Đang xử lý… ${(Editor.progress * 100).toInt()}%" else "Cắt và lưu", enabled = Editor.busy == null && name.isNotBlank(),
            icon = Ic.cut, modifier = Modifier.fillMaxWidth(),
            onClick = {
                previewing = false
                Editor.cut(ctx, t, range.start.toLong(), range.endInclusive.toLong(), name.trim()) { err ->
                    vm.toast(err ?: "Đã cắt xong \"${name.trim()}\" – có trong Thư viện → Cắt / ghép.")
                    if (err == null) vm.cutting = null
                }
            },
        )
    }
}

/* ------------------------------------------------------------------ ghép nhiều bài */
@OptIn(UnstableApi::class)
@Composable
fun MergeScreen(vm: MainVM) {
    val c = cv
    val ctx = LocalContext.current
    val lib by Store.lib.collectAsState()
    var order by remember { mutableStateOf(vm.selecting.mapNotNull { lib.tracks[it] }) }
    var name by remember { mutableStateOf("Ghép ${order.size} bài") }
    BackHandler { vm.merging = false }
    Column(
        Modifier.fillMaxSize().background(c.bg).statusBarsPadding().navigationBarsPadding().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            IconBtn(Ic.back, "Đóng", { vm.merging = false }, color = c.surface)
            H("Ghép ${order.size} bài", size = 20)
        }
        Hint("Sắp thứ tự bằng nút ▲▼. Tổng ${fmtDur(order.sumOf { it.duration })}. Bài gốc giữ nguyên.")
        LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            itemsIndexed(order, key = { _, t -> t.id }) { i, t ->
                Row(
                    Modifier.fillMaxWidth().brutal(c.surface, c.ink, shadow = 2.dp, border = 2.dp).padding(8.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Text("${i + 1}.", color = c.muted, fontWeight = FontWeight.Bold)
                    Column(Modifier.weight(1f)) {
                        Text(t.title, color = c.text, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Hint(fmtDur(t.duration))
                    }
                    IconBtn(Ic.up, "Lên", { if (i > 0) order = order.toMutableList().apply { add(i - 1, removeAt(i)) } }, color = c.surface, enabled = i > 0)
                    IconBtn(Ic.down, "Xuống", { if (i < order.size - 1) order = order.toMutableList().apply { add(i + 1, removeAt(i)) } }, color = c.surface, enabled = i < order.size - 1)
                }
            }
        }
        Field("Tên bài mới", name, { name = it.take(80) })
        BButton(
            if (Editor.busy != null) "Đang ghép… ${(Editor.progress * 100).toInt()}%" else "Ghép và lưu", enabled = Editor.busy == null && order.size >= 2 && name.isNotBlank(),
            icon = Ic.merge, modifier = Modifier.fillMaxWidth(),
            onClick = {
                Editor.merge(ctx, order, name.trim()) { err ->
                    vm.toast(err ?: "Đã ghép xong \"${name.trim()}\".")
                    if (err == null) {
                        vm.merging = false; vm.selecting = emptyList()
                    }
                }
            },
        )
    }
}

@Suppress("unused")
private val keepColor = Color.Unspecified
