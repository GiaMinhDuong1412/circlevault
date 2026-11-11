package vn.circlevault.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import vn.circlevault.app.Downloads
import vn.circlevault.app.JState
import vn.circlevault.app.MainVM
import vn.circlevault.app.OnlineTrack
import vn.circlevault.app.PlayerConn
import vn.circlevault.app.Prefs
import vn.circlevault.app.Store
import vn.circlevault.app.YouTube
import vn.circlevault.app.fmtDur

/* ------------------------------------------------------------------ tab Online: YouTube · Google Drive · Xem chung */
@Composable
fun OnlineTab(vm: MainVM) {
    val c = cv
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, top = 12.dp, bottom = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf("YouTube", "Google Drive", "Xem chung").forEachIndexed { i, t ->
                BButton(t, { vm.onlineSeg = i }, Modifier.weight(1f), small = true, color = if (vm.onlineSeg == i) c.green else c.surface)
            }
        }
        Box(Modifier.weight(1f)) {
            when (vm.onlineSeg) {
                1 -> DriveSection(vm)
                2 -> PartySection(vm)
                else -> YouTubePane(vm)
            }
        }
    }
}

/* ---- YouTube (qua máy tính hoặc trực tiếp) */
@Composable
private fun YouTubePane(vm: MainVM) {
    val c = cv
    val focus = LocalFocusManager.current
    val lib by Store.lib.collectAsState()
    val jobs by Downloads.jobs.collectAsState()
    val jobMap = jobs.associateBy { it.key }
    val ps = rememberPState()
    LaunchedEffect(Unit) { if (vm.ytLogged == null) vm.loadMyLists() }
    BackHandler(enabled = vm.onlineList != null) { vm.onlineList = null }
    val list = vm.onlineList

    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 12.dp, end = 12.dp, top = 12.dp, bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item {
            Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Field(
                    "", vm.onlineQ, { vm.onlineQ = it }, "Tìm bài trên YouTube hoặc dán link",
                    KeyboardOptions(imeAction = ImeAction.Search), Modifier.weight(1f),
                    actions = KeyboardActions(onSearch = { focus.clearFocus(); vm.searchOnline() }),
                )
                IconBtn(Ic.search, "Tìm", { focus.clearFocus(); vm.searchOnline() }, color = c.yellow)
            }
        }
        item {
            val via = if (Prefs.paired && YouTube.pcOk) "Đang nghe qua máy tính (dùng tài khoản YouTube trên máy tính)"
            else "Máy tính không kết nối: điện thoại tự lấy nhạc từ YouTube (playlist riêng tư cần máy tính)"
            Hint("● $via", color = if (Prefs.paired && YouTube.pcOk) Color(0xFF1C9E5C) else c.muted)
        }
        if (vm.onlineBusy) item { Hint("Đang tải…") }
        vm.onlineErr?.let { item { Card(color = c.surface2) { Text(it, color = c.red, fontWeight = FontWeight.Bold) } } }

        if (list == null) {
            item { H("Playlist YouTube của bạn", size = 16) }
            if (vm.myLists.isEmpty()) {
                item {
                    Hint(
                        when {
                            !Prefs.paired -> "Ghép với máy tính (tab Máy tính) để thấy playlist YouTube của bạn. Vẫn tìm và nghe bài được ngay."
                            vm.ytLogged == false -> "Máy tính chưa đăng nhập YouTube. Trên máy tính: Nghe Nhạc → Playlist online → Đăng nhập."
                            else -> "Chưa tải được danh sách. Máy tính cần bật và cùng Wi-Fi."
                        },
                    )
                }
            }
            items(vm.myLists, key = { "ml" + it.id }) { l ->
                Row(
                    Modifier.fillMaxWidth().brutal(c.surface, c.ink, shadow = 2.dp, border = 2.dp).clickable { vm.openOnline(l.id) }.padding(12.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Box(Modifier.size(44.dp).brutal(c.red, c.ink, shadow = 0.dp, border = 2.dp), contentAlignment = Alignment.Center) {
                        Icon(Ic.play, null, tint = Color.White)
                    }
                    Column(Modifier.weight(1f)) {
                        Text(l.title, color = c.text, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (l.count > 0) Hint("${l.count} bài")
                    }
                }
            }
        } else {
            item {
                Card {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        IconBtn(Ic.back, "Quay lại", { vm.onlineList = null }, color = c.surface)
                        Column(Modifier.weight(1f)) {
                            Text(list.title, color = c.text, fontWeight = FontWeight.Black, fontSize = 17.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            val have = list.tracks.count { Store.byYt(it.yt) != null }
                            Hint("${list.tracks.size} bài" + if (have > 0) " · $have bài đã lưu" else "")
                        }
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        BButton("Phát", { PlayerConn.playOnline(list.tracks, 0) }, Modifier.weight(1f), icon = Ic.play, enabled = list.tracks.isNotEmpty())
                        BButton("Lưu hết", { vm.saveOnline(list.tracks, list) }, Modifier.weight(1f), icon = Ic.download, color = c.yellow, enabled = list.tracks.isNotEmpty())
                    }
                    Hint("Lưu về điện thoại thì máy tính sẽ hỏi có tải bản MP3 về ổ HDD không.")
                }
            }
            itemsIndexed(list.tracks, key = { i, t -> "o$i" + t.yt }) { i, t ->
                OnlineRow(t, playing = ps.mediaId == "y${t.yt}" || Store.byYt(t.yt)?.let { ps.mediaId == "t${it.id}" } == true,
                    saved = lib.tracks.values.any { it.yt == t.yt }, job = jobMap["y${t.yt}"]?.state,
                    onPlay = { PlayerConn.playOnline(list.tracks, i) }, onSave = { vm.saveOnline(listOf(t), list) })
            }
        }
    }
}

@Composable
private fun OnlineRow(t: OnlineTrack, playing: Boolean, saved: Boolean, job: JState?, onPlay: () -> Unit, onSave: () -> Unit) {
    val c = cv
    Row(
        Modifier.fillMaxWidth().brutal(c.surface, c.ink, shadow = 2.dp, border = 2.dp).clickable(onClick = onPlay)
            .padding(start = 8.dp, end = 6.dp, top = 6.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Thumb(t.thumb, Ic.music, size = 52)
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text((if (playing) "▶ " else "") + t.title, color = c.text, fontWeight = if (playing) FontWeight.Black else FontWeight.Bold, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Hint(listOfNotNull(t.artist, fmtDur(t.duration).ifBlank { null }).joinToString(" · "))
        }
        when {
            saved -> Box(Modifier.size(46.dp), contentAlignment = Alignment.Center) { Icon(Ic.check, "Đã lưu", tint = Color(0xFF1C9E5C)) }
            job == JState.QUEUED || job == JState.RUNNING -> Box(Modifier.size(46.dp), contentAlignment = Alignment.Center) { Text("…", color = c.muted, fontWeight = FontWeight.Black) }
            else -> IconBtn(Ic.download, "Lưu về máy", onSave, color = if (job == JState.ERROR) c.red else c.yellow)
        }
    }
}
