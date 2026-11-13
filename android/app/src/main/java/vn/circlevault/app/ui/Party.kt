package vn.circlevault.app.ui

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.webkit.PermissionRequest
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import android.view.View
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import vn.circlevault.app.Api
import vn.circlevault.app.MainVM
import vn.circlevault.app.PlayerConn
import vn.circlevault.app.Prefs

/* ------------------------------------------------------------------ Xem chung trong tab Online */
@Composable
fun PartySection(vm: MainVM) {
    val c = cv
    val ctx = LocalContext.current
    var room by remember { mutableStateOf<Triple<String, String, Int>?>(null) }   // (tên phim, link, số người)
    var voice by remember { mutableStateOf<Triple<String, String, String>?>(null) }   // (tên phòng thoại, link, mô tả)
    var checked by remember { mutableStateOf(false) }
    var link by remember { mutableStateOf("") }
    var reload by remember { mutableStateOf(0) }
    LaunchedEffect(reload) {
        checked = false
        room = null
        voice = null
        if (Prefs.paired) runCatching {
            val j = Api.party()
            j.optJSONObject("voice")?.let { v ->
                val l = v.optString("link")
                if (l.isNotBlank()) voice = Triple(v.optString("name", "Phòng thoại"), l,
                    "${v.optInt("online")} người trong phòng" + (if (v.optInt("talking") > 0) " · ${v.optInt("talking")} đang nói chuyện" else ""))
            }
            val r = j.optJSONObject("room")
            val links = j.optJSONObject("links")
            val url = links?.optString("lan")?.ifBlank { null } ?: links?.optString("internet")?.ifBlank { null }
            if (r != null && url != null) room = Triple(r.optString("title", "Phòng xem chung"), url, r.optInt("members"))
        }
        checked = true
    }
    fun open(u: String) {
        val url = u.trim()
        if (!url.startsWith("http") || !(url.contains("/r/") || url.contains("/v/")))
            vm.toast("Link phòng có dạng http(s)://…/r/<mã> (xem chung) hoặc …/v/<mã> (phòng thoại).")
        else vm.partyUrl = url
    }
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 12.dp, end = 12.dp, top = 4.dp, bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item {
            val r = room
            when {
                r != null -> Card(color = c.green) {
                    Text("Phòng đang mở trên máy tính", color = c.onAccent, fontSize = 13.sp, fontWeight = FontWeight.Bold)
                    Text(r.first, color = c.onAccent, fontWeight = FontWeight.Black, fontSize = 18.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text("${r.third} người đang xem", color = c.onAccent, fontSize = 13.sp)
                    BButton("Vào phòng", { open(r.second) }, color = c.yellow, icon = Ic.play)
                }
                !Prefs.paired -> Card { Hint("Ghép với máy tính (tab Máy tính) để thấy phòng đang mở. Phòng của bạn bè thì dán link hoặc quét mã bên dưới.") }
                checked -> Card {
                    Text("Máy tính chưa mở phòng nào.", color = c.text, fontWeight = FontWeight.Bold)
                    Hint("Trên máy tính: tab Xem Chung → chọn phim trong thư viện hoặc link YouTube → Mở phòng.")
                    BButton("Kiểm tra lại", { reload++ }, small = true, color = c.surface)
                }
                else -> Hint("Đang hỏi máy tính…")
            }
        }
        voice?.let { v ->
            item {
                Card(color = c.yellow) {
                    Text("Phòng thoại trên máy tính", color = c.onAccent, fontSize = 13.sp, fontWeight = FontWeight.Bold)
                    Text(v.first, color = c.onAccent, fontWeight = FontWeight.Black, fontSize = 18.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text(v.third, color = c.onAccent, fontSize = 13.sp)
                    BButton("Vào phòng thoại", { open(v.second) }, color = c.green, icon = Ic.play)
                }
            }
        }
        item {
            Card {
                H("Vào phòng bằng link", size = 16)
                Hint("Dán link phòng xem chung (…/r/…) hoặc phòng thoại (…/v/…) bạn bè gửi, hoặc quét mã QR.")
                Field("", link, { link = it.trim() }, "https://…/r/… hoặc …/v/…", KeyboardOptions(keyboardType = KeyboardType.Uri))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    BButton("Vào phòng", { open(link) }, Modifier.weight(1f), enabled = link.isNotBlank())
                    BButton("Quét QR", {
                        GmsBarcodeScanning.getClient(ctx, GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build())
                            .startScan().addOnSuccessListener { b -> b.rawValue?.let { open(it) } }
                            .addOnFailureListener { vm.toast("Không mở được máy quét: ${it.message}") }
                    }, Modifier.weight(1f), color = c.yellow, icon = Ic.qr)
                }
            }
        }
    }
}

/** Trang phòng xem chung (cùng trang bạn bè mở bằng trình duyệt) trong app, xem toàn màn hình được. */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun PartyScreen(url: String, onClose: () -> Unit) {
    val c = cv
    val ctx = LocalContext.current
    val act = ctx as? Activity
    var full by remember { mutableStateOf<View?>(null) }
    var fullCb by remember { mutableStateOf<WebChromeClient.CustomViewCallback?>(null) }
    var web by remember { mutableStateOf<WebView?>(null) }
    val isVoice = url.contains("/v/")
    // trang phòng thoại xin micro → hỏi quyền Android (một lần) rồi mới cho trang dùng
    var pending by remember { mutableStateOf<PermissionRequest?>(null) }
    val askMic = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        pending?.let { r -> if (ok) r.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) else r.deny() }
        pending = null
    }
    DisposableEffect(Unit) {
        PlayerConn.controller?.pause()
        onDispose {
            act?.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
            web?.destroy()
        }
    }
    BackHandler {
        when {
            full != null -> fullCb?.onCustomViewHidden()
            else -> onClose()
        }
    }
    Column(Modifier.fillMaxSize().background(Color.Black)) {
        if (full == null) {
            Row(
                Modifier.fillMaxWidth().background(c.cyan).statusBarsPadding().padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconBtn(Ic.back, "Rời phòng", onClose, color = c.surface)
                Spacer(Modifier.width(10.dp))
                Text(if (isVoice) "Phòng thoại" else "Xem chung", color = c.onAccent, fontWeight = FontWeight.Black, fontSize = 18.sp)
            }
        }
        Box(Modifier.weight(1f).fillMaxWidth().then(if (full == null) Modifier.navigationBarsPadding() else Modifier)) {
            AndroidView(
                factory = { context ->
                    WebView(context).apply {
                        layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                        settings.javaScriptEnabled = true
                        settings.domStorageEnabled = true
                        settings.mediaPlaybackRequiresUserGesture = false
                        keepScreenOn = true
                        webViewClient = object : WebViewClient() {
                            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = false
                        }
                        webChromeClient = object : WebChromeClient() {
                            override fun onPermissionRequest(request: PermissionRequest) {
                                val host = android.net.Uri.parse(url).host
                                if (request.origin.host != host || PermissionRequest.RESOURCE_AUDIO_CAPTURE !in request.resources) {
                                    request.deny(); return
                                }
                                if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                                    request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
                                } else {
                                    pending = request
                                    askMic.launch(Manifest.permission.RECORD_AUDIO)
                                }
                            }

                            override fun onShowCustomView(view: View, callback: CustomViewCallback) {
                                full = view; fullCb = callback
                                act?.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                            }

                            override fun onHideCustomView() {
                                full = null; fullCb = null
                                act?.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
                            }
                        }
                        loadUrl(url)
                        web = this
                    }
                },
                modifier = Modifier.fillMaxSize(),
            )
            full?.let { v ->
                AndroidView(factory = { context ->
                    FrameLayout(context).apply {
                        setBackgroundColor(android.graphics.Color.BLACK)
                        (v.parent as? ViewGroup)?.removeView(v)
                        addView(v, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
                    }
                }, modifier = Modifier.fillMaxSize())
            }
        }
    }
}
