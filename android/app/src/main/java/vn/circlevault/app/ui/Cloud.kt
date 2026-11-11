package vn.circlevault.app.ui

import android.accounts.AccountManager
import android.app.Activity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
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
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.google.android.gms.auth.api.identity.Identity
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import vn.circlevault.app.DJob
import vn.circlevault.app.Downloads
import vn.circlevault.app.Drive
import vn.circlevault.app.JState
import vn.circlevault.app.MainVM
import vn.circlevault.app.PlayerConn
import vn.circlevault.app.Store
import vn.circlevault.app.YouTube
import vn.circlevault.app.fmtBytes
import vn.circlevault.app.safeName
import java.io.File

/** Đăng nhập Google Drive: chọn tài khoản trên máy → Google hỏi cho phép → lưu tài khoản. Dùng chung cho tab Online và Thư viện. */
class DriveAuth(val add: () -> Unit, val reauth: (String) -> Unit)

@Composable
fun rememberDriveAuth(vm: MainVM, onDone: () -> Unit = {}): DriveAuth {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var pending by remember { mutableStateOf("") }
    val finish: (String) -> Unit = { email ->
        scope.launch {
            try {
                Drive.addAccount(ctx, email); vm.toast("Đã kết nối Google Drive: $email"); onDone()
            } catch (e: Throwable) {
                vm.toast("Không mở được Drive: ${e.message}")
            }
        }
    }
    val consent = rememberLauncherForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) { res ->
        if (res.resultCode != Activity.RESULT_OK) {
            vm.toast("Chưa cho phép CircleVault dùng Google Drive."); return@rememberLauncherForActivityResult
        }
        val r = runCatching { Identity.getAuthorizationClient(ctx).getAuthorizationResultFromIntent(res.data) }.getOrNull()
        if (r?.accessToken == null) vm.toast("Google không cho phép. Thử lại.") else {
            Drive.remember(pending, r); finish(pending)
        }
    }
    val authorize: (String) -> Unit = { email ->
        pending = email
        scope.launch {
            try {
                val r = Identity.getAuthorizationClient(ctx).authorize(Drive.request(email)).await()
                if (r.hasResolution()) consent.launch(IntentSenderRequest.Builder(r.pendingIntent!!.intentSender).build())
                else {
                    Drive.remember(email, r); finish(email)
                }
            } catch (e: Throwable) {
                vm.toast("Không đăng nhập được Google: ${e.message}. Kiểm tra đã tạo client Android trong Google Cloud.")
            }
        }
    }
    val chooser = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { res ->
        val email = res.data?.getStringExtra(AccountManager.KEY_ACCOUNT_NAME)
        if (res.resultCode == Activity.RESULT_OK && !email.isNullOrBlank()) authorize(email)
    }
    return remember {
        DriveAuth(
            add = {
                chooser.launch(AccountManager.newChooseAccountIntent(null, null, arrayOf("com.google"), null, null, null, null))
            },
            reauth = authorize,
        )
    }
}

/* ------------------------------------------------------------------ Google Drive trong tab Online */
@Composable
fun DriveSection(vm: MainVM) {
    val c = cv
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val lib by Store.lib.collectAsState()
    val jobs by Downloads.jobs.collectAsState()
    val ps = rememberPState()
    var path by remember(Drive.active) { mutableStateOf(listOf<Pair<String, String>>()) }   // (id, tên) – thư mục đang xem
    var items by remember { mutableStateOf<List<Drive.Item>?>(null) }
    var err by remember { mutableStateOf<String?>(null) }
    var needAuth by remember { mutableStateOf(false) }
    var pickFolder by remember { mutableStateOf<List<Drive.Item>?>(null) }
    var newName by remember { mutableStateOf("") }
    var reload by remember { mutableStateOf(0) }
    val auth = rememberDriveAuth(vm) { reload++ }
    val acc = Drive.acc()
    val cur = path.lastOrNull()?.first ?: acc?.folderId

    LaunchedEffect(Drive.active, cur, reload) {
        items = null; err = null; needAuth = false
        if (acc == null || cur == null) return@LaunchedEffect
        try {
            items = Drive.children(ctx, cur)
        } catch (e: Drive.NeedConsent) {
            needAuth = true
        } catch (e: Throwable) {
            err = if (e is java.net.UnknownHostException) "Không có Internet." else e.message ?: "Lỗi"
        }
    }

    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 12.dp, end = 12.dp, top = 4.dp, bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (Drive.accounts.isEmpty()) {
            item {
                Card {
                    H("Kết nối Google Drive")
                    Text("Nghe và tải về nhạc đã lưu trên Drive (kể cả nhạc máy tính tải lên), hoặc đưa nhạc từ điện thoại lên Drive. App chỉ thấy file do CircleVault tạo.", color = c.text)
                    BButton("Thêm tài khoản Google", auth.add, icon = Ic.download, color = c.yellow)
                }
            }
            return@LazyColumn
        }
        // ---- chọn tài khoản
        item {
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                items(Drive.accounts, key = { it.email }) { a ->
                    val on = a.email == Drive.active
                    Box(
                        Modifier.brutal(if (on) c.ink else c.surface, c.ink, shadow = 0.dp, radius = 18.dp, border = 2.dp)
                            .clickable { Drive.choose(a.email) }.padding(horizontal = 12.dp, vertical = 7.dp),
                    ) { Text(a.email, color = if (on) c.bg else c.text, fontWeight = FontWeight.Bold, fontSize = 13.sp) }
                }
                item { BButton("+ Thêm", auth.add, small = true, color = c.surface) }
            }
        }
        if (acc != null) {
            item {
                Card {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text("Thư mục lưu: ${acc.folderName ?: "—"}", color = c.text, fontWeight = FontWeight.ExtraBold)
                            Hint("Nhạc đưa lên từ điện thoại vào đây; playlist là thư mục con.")
                        }
                        BButton("Đổi", {
                            scope.launch { pickFolder = runCatching { Drive.listFolders(ctx) }.getOrElse { vm.toast(it.message ?: "Lỗi"); null } }
                        }, small = true, color = c.surface)
                    }
                    pickFolder?.let { fl ->
                        val top = fl
                        Hint("Chọn thư mục CircleVault đã tạo, hoặc tạo mới:")
                        top.take(30).forEach { f ->
                            Text("📁 ${f.name}", color = c.text, fontWeight = FontWeight.Bold, modifier = Modifier.fillMaxWidth().clickable {
                                scope.launch { Drive.setFolder(ctx, acc.email, f.id, f.name); pickFolder = null; path = emptyList(); reload++ }
                            }.padding(vertical = 6.dp))
                        }
                        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Field("", newName, { newName = it.take(80) }, "Tên thư mục mới", modifier = Modifier.weight(1f))
                            BButton("Tạo", {
                                if (newName.isNotBlank()) scope.launch {
                                    runCatching { Drive.setFolder(ctx, acc.email, null, newName.trim()) }.onFailure { vm.toast(it.message ?: "Lỗi") }
                                    pickFolder = null; newName = ""; path = emptyList(); reload++
                                }
                            }, small = true)
                        }
                    }
                    BButton("Ngắt tài khoản này", { Drive.removeAccount(acc.email); vm.toast("Đã ngắt ${acc.email}. Nhạc trên Drive vẫn còn.") }, small = true, color = c.surface)
                }
            }
        }
        if (needAuth && acc != null) {
            item {
                Card(color = c.surface2) {
                    Text("Cần cho phép CircleVault dùng Google Drive của ${acc.email}.", color = c.text, fontWeight = FontWeight.Bold)
                    BButton("Cho phép", { auth.reauth(acc.email) }, small = true, color = c.yellow)
                }
            }
        }
        err?.let { item { Card(color = c.surface2) { Text(it, color = c.red, fontWeight = FontWeight.Bold) } } }
        // ---- đường dẫn
        if (acc != null) {
            item {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (path.isNotEmpty()) IconBtn(Ic.back, "Lên trên", { path = path.dropLast(1) }, color = c.surface)
                    Text(
                        (listOf(acc.folderName ?: "CircleVault") + path.map { it.second }).joinToString(" / "),
                        color = c.text, fontWeight = FontWeight.Black, fontSize = 16.sp, modifier = Modifier.weight(1f),
                        maxLines = 2, overflow = TextOverflow.Ellipsis,
                    )
                    IconBtn(Ic.refresh, "Tải lại", { reload++ }, color = c.surface)
                }
            }
        }
        val list = items
        if (acc != null && list == null && err == null && !needAuth) item { Hint("Đang đọc Drive…") }
        if (list != null) {
            val songs = list.filter { Drive.isAudio(it) }
            val vids = list.filter { Drive.isVideo(it) }
            if (list.isEmpty()) item { Hint("Thư mục trống. Trên máy tính: Nghe Nhạc → ☁ Lưu lên Drive, hoặc ở điện thoại: Thư viện → ⋮ → Lưu lên Google Drive.") }
            if (songs.isNotEmpty()) {
                item {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        BButton("Phát ${songs.size} bài", { PlayerConn.playDrive(songs, acc!!.email, 0) }, Modifier.weight(1f), icon = Ic.play)
                        BButton("Tải về máy", {
                            val sub = path.lastOrNull()?.second
                            val n = Downloads.enqueue(ctx, (songs + vids).filter { Store.byGd(it.id) == null }.map { driveJob(it, acc!!.email, sub) })
                            vm.toast(if (n == 0) "Đã có trên điện thoại." else "Đang tải $n file từ Drive về điện thoại.")
                        }, Modifier.weight(1f), color = c.yellow, icon = Ic.download)
                    }
                }
            }
            items(list.filter { it.isFolder }, key = { "df" + it.id }) { f ->
                Row(
                    Modifier.fillMaxWidth().brutal(c.surface, c.ink, shadow = 2.dp, border = 2.dp).clickable { path = path + (f.id to f.name) }.padding(12.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Box(Modifier.size(40.dp).brutal(c.yellow, c.ink, shadow = 0.dp, border = 2.dp), contentAlignment = Alignment.Center) { Icon(Ic.music, null, tint = c.onAccent) }
                    Text(f.name, color = c.text, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                    Text("›", color = c.muted, fontSize = 22.sp)
                }
            }
            itemsIndexed(songs + vids, key = { _, f -> "dd" + f.id }) { i, f ->
                val have = Store.byGd(f.id) != null || lib.videos.values.any { it.path.contains("gd-${f.id}") }
                val job = jobs.find { it.key == "g${f.id}" }
                Row(
                    Modifier.fillMaxWidth().brutal(c.surface, c.ink, shadow = 2.dp, border = 2.dp)
                        .clickable { if (Drive.isAudio(f)) PlayerConn.playDrive(songs, acc!!.email, songs.indexOf(f)) else vm.toast("Tải phim về máy rồi xem ở Thư viện.") }
                        .padding(start = 12.dp, end = 6.dp, top = 6.dp, bottom = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        val playing = ps.mediaId == "g${f.id}"
                        Text((if (playing) "▶ " else "") + f.name.substringBeforeLast('.'), color = c.text, fontWeight = if (playing) FontWeight.Black else FontWeight.Bold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        Hint("${f.name.substringAfterLast('.').uppercase()} · ${fmtBytes(f.size)}")
                    }
                    when {
                        have -> Box(Modifier.size(46.dp), contentAlignment = Alignment.Center) { Icon(Ic.check, "Đã có", tint = Color(0xFF1C9E5C)) }
                        job != null && (job.state == JState.QUEUED || job.state == JState.RUNNING) ->
                            Box(Modifier.size(46.dp), contentAlignment = Alignment.Center) { Text(if (job.total > 0) "${job.done * 100 / job.total}%" else "…", color = c.text, fontWeight = FontWeight.Bold, fontSize = 13.sp) }
                        else -> IconBtn(Ic.download, "Tải về máy", { Downloads.enqueue(ctx, listOf(driveJob(f, acc!!.email, path.lastOrNull()?.second))) }, color = if (job?.state == JState.ERROR) c.red else c.yellow)
                    }
                }
            }
        }
    }
}

/** việc tải một file từ Drive về điện thoại (playlist = thư mục con đang xem) */
fun driveJob(f: Drive.Item, email: String, playlist: String?): DJob {
    val sub = if (Drive.isVideo(f)) "phim" else "nhac"
    val dest = File(File(Store.baseDir(), sub), "gd-${f.id} - ${safeName(f.name.substringBeforeLast('.'))}.${f.name.substringAfterLast('.', "mp3")}")
    return DJob(
        key = "g${f.id}", title = f.name.substringBeforeLast('.'), url = Drive.mediaUrl(f.id), dest = dest.path, total = f.size,
        drive = email to f.id, onlinePlaylist = playlist?.let { YouTube.playlistIdFor("gd:$it") to it },
    )
}
