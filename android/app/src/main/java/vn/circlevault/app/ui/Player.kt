package vn.circlevault.app.ui

import android.net.Uri
import android.view.ViewGroup
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import coil.compose.AsyncImage
import kotlinx.coroutines.delay
import vn.circlevault.app.OVideo
import vn.circlevault.app.PlayerConn
import vn.circlevault.app.fmtDur
import java.io.File

@Stable
class PState {
    var has by mutableStateOf(false)
    var title by mutableStateOf("")
    var artist by mutableStateOf("")
    var art by mutableStateOf<Uri?>(null)
    var playing by mutableStateOf(false)
    var pos by mutableLongStateOf(0L)
    var dur by mutableLongStateOf(0L)
    var hasNext by mutableStateOf(false)
    var hasPrev by mutableStateOf(false)
    var mediaId by mutableStateOf<String?>(null)
}

private fun syncState(s: PState, ctl: Player) {
    val item = ctl.currentMediaItem
    s.has = item != null
    s.mediaId = item?.mediaId
    s.title = item?.mediaMetadata?.title?.toString() ?: ""
    s.artist = item?.mediaMetadata?.artist?.toString() ?: ""
    s.art = item?.mediaMetadata?.artworkUri
    s.playing = ctl.isPlaying
    s.hasNext = ctl.hasNextMediaItem()
    s.hasPrev = ctl.hasPreviousMediaItem()
    s.dur = ctl.duration.coerceAtLeast(0)
    s.pos = ctl.currentPosition
}

@Composable
fun rememberPState(): PState {
    val ctl = PlayerConn.controller
    // đọc trạng thái ngay khi tạo (không đợi một nhịp vẽ), sau đó cập nhật theo sự kiện của trình phát
    val s = remember(ctl) { PState().also { st -> ctl?.let { syncState(st, it) } } }
    DisposableEffect(ctl) {
        if (ctl == null) {
            s.has = false
            onDispose { }
        } else {
            val l = object : Player.Listener {
                override fun onEvents(player: Player, events: Player.Events) = syncState(s, ctl)
            }
            ctl.addListener(l)
            syncState(s, ctl)
            onDispose { ctl.removeListener(l) }
        }
    }
    LaunchedEffect(ctl) {
        while (true) {
            ctl?.let {
                s.pos = it.currentPosition
                s.dur = it.duration.coerceAtLeast(0)
            }
            delay(500)
        }
    }
    return s
}

@Composable
private fun Cover(art: Uri?, size: Int) {
    val c = cv
    Box(Modifier.size(size.dp).brutal(c.yellow, c.ink, shadow = 0.dp, radius = 6.dp, border = 2.dp), contentAlignment = Alignment.Center) {
        Icon(Ic.music, null, tint = c.onAccent, modifier = Modifier.size((size / 2).dp))
        if (art != null) AsyncImage(art, null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
    }
}

@Composable
fun MiniPlayer(onOpen: () -> Unit) {
    val c = cv
    val s = rememberPState()
    val ctl = PlayerConn.controller
    if (!s.has || ctl == null) return
    Column(Modifier.fillMaxWidth().background(c.surface)) {
        Box(Modifier.fillMaxWidth().height(2.5.dp).background(c.ink))
        Row(
            Modifier.fillMaxWidth().clickable(onClick = onOpen).padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Cover(s.art, 44)
            Column(Modifier.weight(1f)) {
                Text(s.title, color = c.text, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (s.artist.isNotBlank()) Text(s.artist, color = c.muted, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            IconBtn(if (s.playing) Ic.pause else Ic.play, if (s.playing) "Tạm dừng" else "Phát", {
                if (ctl.isPlaying) ctl.pause() else ctl.play()
            }, color = c.green)
            IconBtn(Ic.next, "Bài sau", { ctl.seekToNext() }, color = c.surface, enabled = s.hasNext)
        }
    }
}

@Composable
fun NowPlaying(vm: vn.circlevault.app.MainVM, onClose: () -> Unit) {
    val c = cv
    val s = rememberPState()
    val ctl = PlayerConn.controller
    var drag by remember { mutableFloatStateOf(-1f) }
    var eqOpen by remember { mutableStateOf(false) }
    BackHandler(onBack = { if (eqOpen) eqOpen = false else onClose() })
    if (eqOpen) {
        EqPanel(s.title, onClose = { eqOpen = false })
        return
    }
    if (!s.has || ctl == null) {
        LaunchedEffect(s.has, ctl) { if (!s.has || ctl == null) onClose() }
        return
    }
    Column(
        Modifier.fillMaxSize().background(c.bg).statusBarsPadding().navigationBarsPadding().padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(18.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            IconBtn(Ic.down, "Thu nhỏ", onClose, color = c.surface)
            Spacer(Modifier.weight(1f))
            val online = if (s.mediaId?.startsWith("y") == true) PlayerConn.currentOnline() else null
            if (online != null && vn.circlevault.app.Store.byYt(online.yt) == null) {
                BButton("Lưu", { vm.saveOnline(listOf(online), null) }, small = true, icon = Ic.download, color = c.yellow)
            }
            BButton("＋ Playlist", { vm.addCurrentToPlaylist() }, small = true, color = c.surface)
            BButton("EQ", { eqOpen = true }, small = true, icon = Ic.eq, color = if (vn.circlevault.app.Eq.own) c.violet else c.surface)
        }
        Box(Modifier.fillMaxWidth(0.85f).aspectRatio(1f).brutal(c.yellow, c.ink, shadow = 6.dp, radius = 10.dp, border = 3.dp), contentAlignment = Alignment.Center) {
            Icon(Ic.music, null, tint = c.onAccent, modifier = Modifier.size(96.dp))
            if (s.art != null) AsyncImage(s.art, null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        }
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(s.title, color = c.text, fontWeight = FontWeight.Black, fontSize = 21.sp, textAlign = TextAlign.Center, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (s.artist.isNotBlank()) Text(s.artist, color = c.muted, fontSize = 15.sp, textAlign = TextAlign.Center)
        }
        Column {
            Slider(
                value = if (drag >= 0) drag else if (s.dur > 0) s.pos.toFloat() / s.dur else 0f,
                onValueChange = { drag = it },
                onValueChangeFinished = {
                    if (s.dur > 0 && drag >= 0) ctl.seekTo((drag * s.dur).toLong())
                    drag = -1f
                },
                colors = SliderDefaults.colors(thumbColor = c.ink, activeTrackColor = c.cyan, inactiveTrackColor = c.surface2),
            )
            Row(Modifier.fillMaxWidth()) {
                Text(fmtDur(s.pos / 1000.0).ifBlank { "0:00" }, color = c.muted, fontSize = 13.sp, modifier = Modifier.weight(1f))
                Text(fmtDur(s.dur / 1000.0), color = c.muted, fontSize = 13.sp)
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
            IconBtn(Ic.prev, "Bài trước", { ctl.seekToPrevious() }, color = c.surface)
            Box(
                Modifier.brutal(c.green, c.ink, shadow = 4.dp, radius = 40.dp, border = 2.5.dp)
                    .clickable { if (ctl.isPlaying) ctl.pause() else ctl.play() }
                    .size(76.dp),
                contentAlignment = Alignment.Center,
            ) { Icon(if (s.playing) Ic.pause else Ic.play, null, tint = c.onAccent, modifier = Modifier.size(38.dp)) }
            IconBtn(Ic.next, "Bài sau", { ctl.seekToNext() }, color = c.surface, enabled = s.hasNext)
        }
        Spacer(Modifier.weight(1f))
    }
}

/** Xem phim trên điện thoại: trình phát riêng (không qua dịch vụ nhạc), xoay ngang tự vừa màn hình. */
@Composable
fun VideoScreen(v: OVideo, onClose: () -> Unit) {
    val ctx = LocalContext.current
    val player = remember(v.id) {
        ExoPlayer.Builder(ctx)
            .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(), true)
            .build().apply {
                setMediaItem(MediaItem.fromUri(Uri.fromFile(File(v.path))))
                prepare()
                playWhenReady = true
            }
    }
    DisposableEffect(v.id) {
        PlayerConn.controller?.pause()
        onDispose { player.release() }
    }
    BackHandler(onBack = onClose)
    Box(Modifier.fillMaxSize().background(Color.Black)) {
        AndroidView(
            factory = {
                PlayerView(it).apply {
                    layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                    this.player = player
                    keepScreenOn = true
                    setShowNextButton(false)
                    setShowPreviousButton(false)
                }
            },
            modifier = Modifier.fillMaxSize().systemBarsPadding(),
        )
        Row(Modifier.systemBarsPadding().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            IconBtn(Ic.back, "Đóng", onClose, color = cv.surface)
            Spacer(Modifier.width(10.dp))
            Text(v.title, color = Color.White, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** Bộ chỉnh âm: kiểu dựng sẵn + 5 dải, áp cho mọi bài hoặc riêng bài đang nghe */
@Composable
fun EqPanel(title: String, onClose: () -> Unit) {
    val c = cv
    val eq = vn.circlevault.app.Eq
    Column(
        Modifier.fillMaxSize().background(c.bg).statusBarsPadding().navigationBarsPadding()
            .verticalScroll(androidx.compose.foundation.rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            IconBtn(Ic.back, "Đóng", onClose, color = c.surface)
            Column(Modifier.weight(1f)) {
                H("Bộ chỉnh âm", size = 20)
                Text(title, color = c.muted, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            BButton(if (eq.enabled) "Đang bật" else "Đang tắt", { eq.turn(!eq.enabled) }, small = true, color = if (eq.enabled) c.green else c.surface)
        }
        if (!eq.supported) Card(color = c.surface2) { Text("Điện thoại này không hỗ trợ bộ chỉnh âm cho app.", color = c.red, fontWeight = FontWeight.Bold) }
        Card(color = if (eq.own) c.violet else c.surface) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(if (eq.own) "Đang dùng EQ riêng cho bài này" else "Đang dùng EQ chung cho mọi bài", color = if (eq.own) c.onAccent else c.text, fontWeight = FontWeight.ExtraBold)
                    Text(
                        if (eq.own) "Chỉnh gì cũng chỉ áp cho bài này, lần sau nghe lại vẫn nhớ." else "Bật \"Riêng bài này\" để bài này có EQ của nó.",
                        color = if (eq.own) c.onAccent else c.muted, fontSize = 13.sp,
                    )
                }
                androidx.compose.material3.Switch(eq.own, { eq.useOwn(it) }, enabled = eq.key != null)
            }
        }
        Text("Kiểu có sẵn", color = c.text, fontWeight = FontWeight.Bold)
        val cur = eq.presetName()
        vn.circlevault.app.Eq.PRESETS.keys.chunked(3).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                row.forEach { name ->
                    BButton(name, { eq.preset(name) }, Modifier.weight(1f), small = true, color = if (cur == name) c.yellow else c.surface)
                }
                repeat(3 - row.size) { Spacer(Modifier.weight(1f)) }
            }
        }
        Card {
            eq.REF_HZ.forEachIndexed { i, hz ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("${eq.label(hz)}Hz", color = c.text, fontWeight = FontWeight.Bold, fontSize = 13.sp, modifier = Modifier.width(58.dp))
                    Slider(
                        value = eq.levels[i], onValueChange = { eq.setLevel(i, it) }, valueRange = eq.minDb..eq.maxDb,
                        modifier = Modifier.weight(1f),
                        colors = SliderDefaults.colors(thumbColor = c.ink, activeTrackColor = c.cyan, inactiveTrackColor = c.surface2),
                    )
                    Text("%+.0f dB".format(eq.levels[i]), color = c.muted, fontSize = 13.sp, modifier = Modifier.width(52.dp), textAlign = TextAlign.End)
                }
            }
            Hint("Âm trầm ở bên trái (60 Hz), âm cao ở bên phải (14 kHz).")
        }
    }
}
