package vn.circlevault.app

import android.accounts.Account
import android.app.PendingIntent
import android.content.Context
import android.net.Uri
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.AuthorizationResult
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.common.api.Scope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/**
 * Google Drive trên điện thoại (quyền drive.file – chỉ thấy file CircleVault tạo, kể cả file máy tính đã tải lên vì cùng
 * project Google Cloud). Đăng nhập bằng tài khoản Google có sẵn trên điện thoại (Google Identity AuthorizationClient,
 * client Android đăng ký theo tên gói + SHA-1 khóa ký). Nhiều tài khoản; mỗi tài khoản một thư mục gốc (mặc định "CircleVault").
 */
object Drive {
    const val SCOPE = "https://www.googleapis.com/auth/drive.file"
    private const val API = "https://www.googleapis.com/drive/v3"
    private const val UPLOAD = "https://www.googleapis.com/upload/drive/v3/files"
    const val FOLDER = "application/vnd.google-apps.folder"

    data class Acc(val email: String, val folderId: String?, val folderName: String?)
    data class Item(val id: String, val name: String, val mime: String, val size: Long, val isFolder: Boolean)

    /** cần người dùng bấm đồng ý (mở màn hình của Google) */
    class NeedConsent(val intent: PendingIntent) : Exception("Cần cho phép CircleVault dùng Google Drive")

    var accounts by mutableStateOf(load())
    var active by mutableStateOf(Prefs.gdActive.ifBlank { accounts.firstOrNull()?.email ?: "" })
    private val tokens = ConcurrentHashMap<String, Pair<String, Long>>()

    private fun load(): List<Acc> = runCatching {
        val a = JSONArray(Prefs.gdAccounts)
        (0 until a.length()).map { a.getJSONObject(it) }.map {
            Acc(it.getString("email"), it.optString("folderId").ifBlank { null }, it.optString("folderName").ifBlank { null })
        }
    }.getOrDefault(emptyList())

    private fun save() {
        Prefs.gdAccounts = JSONArray(accounts.map {
            JSONObject().put("email", it.email).put("folderId", it.folderId ?: "").put("folderName", it.folderName ?: "")
        }).toString()
        Prefs.gdActive = active
    }

    fun acc(email: String = active) = accounts.find { it.email == email }

    fun request(email: String?): AuthorizationRequest = AuthorizationRequest.builder()
        .setRequestedScopes(listOf(Scope(SCOPE)))
        .apply { if (!email.isNullOrBlank()) setAccount(Account(email, "com.google")) }
        .build()

    fun remember(email: String, r: AuthorizationResult) {
        r.accessToken?.let { tokens[email] = it to System.currentTimeMillis() + 50 * 60_000L }
    }

    /** token truy cập (tự lấy lại im lặng khi đã cho phép một lần) */
    suspend fun token(ctx: Context, email: String = active): String {
        tokens[email]?.let { (t, exp) -> if (exp > System.currentTimeMillis()) return t }
        val r = Identity.getAuthorizationClient(ctx).authorize(request(email)).await()
        if (r.hasResolution()) throw NeedConsent(r.pendingIntent!!)
        remember(email, r)
        return r.accessToken ?: throw IOException("Google không trả mã truy cập")
    }

    fun tokenBlocking(ctx: Context, email: String): String = runBlocking { token(ctx, email) }

    fun forget(email: String) {
        tokens.remove(email)
    }

    private suspend fun call(ctx: Context, email: String, b: Request.Builder): JSONObject = withContext(Dispatchers.IO) {
        var tk = token(ctx, email)
        repeat(2) { attempt ->
            Api.http.newCall(b.header("Authorization", "Bearer $tk").build()).execute().use { r ->
                val text = r.body?.string() ?: ""
                if (r.code == 401 && attempt == 0) {
                    tokens.remove(email)
                    runCatching { com.google.android.gms.auth.GoogleAuthUtil.clearToken(ctx, tk) }   // token cũ hết hạn → xin cái mới
                    tk = token(ctx, email)
                    return@repeat
                }
                if (!r.isSuccessful) {
                    val msg = runCatching { JSONObject(text).getJSONObject("error").getString("message") }.getOrDefault("Lỗi ${r.code}")
                    throw IOException(
                        if ("has not been used" in msg || "is disabled" in msg) "Google Drive API chưa bật trong project Google Cloud." else msg,
                    )
                }
                return@withContext if (text.isBlank()) JSONObject() else JSONObject(text)
            }
        }
        throw IOException("Không đăng nhập được Google Drive")
    }

    private fun q(s: String) = s.replace("\\", "\\\\").replace("'", "\\'")

    suspend fun ensureFolder(ctx: Context, email: String, name: String, parent: String? = null): String {
        val query = "mimeType='$FOLDER' and trashed=false and name='${q(name)}'" + (parent?.let { " and '$it' in parents" } ?: "")
        val found = call(ctx, email, Request.Builder().url("$API/files?fields=files(id)&pageSize=1&q=${Uri.encode(query)}"))
            .optJSONArray("files")
        if (found != null && found.length() > 0) return found.getJSONObject(0).getString("id")
        val meta = JSONObject().put("name", name).put("mimeType", FOLDER).apply { if (parent != null) put("parents", JSONArray(listOf(parent))) }
        return call(ctx, email, Request.Builder().url("$API/files?fields=id").post(meta.toString().toRequestBody("application/json".toMediaType())))
            .getString("id")
    }

    /** thêm tài khoản sau khi người dùng đã cho phép; tạo thư mục CircleVault nếu chưa có */
    suspend fun addAccount(ctx: Context, email: String) {
        val folder = ensureFolder(ctx, email, "CircleVault")
        accounts = accounts.filterNot { it.email == email } + Acc(email, folder, "CircleVault")
        active = email
        save()
    }

    fun choose(email: String) {
        active = email
        save()
    }

    fun removeAccount(email: String) {
        accounts = accounts.filterNot { it.email == email }
        if (active == email) active = accounts.firstOrNull()?.email ?: ""
        tokens.remove(email)
        save()
    }

    suspend fun listFolders(ctx: Context, email: String = active): List<Item> =
        list(ctx, email, "mimeType='$FOLDER' and trashed=false")

    suspend fun setFolder(ctx: Context, email: String, id: String?, name: String) {
        val fid = id ?: ensureFolder(ctx, email, name)
        accounts = accounts.map { if (it.email == email) it.copy(folderId = fid, folderName = name) else it }
        save()
    }

    suspend fun children(ctx: Context, folderId: String, email: String = active): List<Item> =
        list(ctx, email, "'$folderId' in parents and trashed=false")
            .sortedWith(compareByDescending<Item> { it.isFolder }.thenBy { it.name.lowercase() })

    private suspend fun list(ctx: Context, email: String, query: String): List<Item> {
        val out = mutableListOf<Item>()
        var page: String? = null
        do {
            val url = "$API/files?pageSize=500&fields=nextPageToken,files(id,name,mimeType,size)&q=${Uri.encode(query)}" +
                (page?.let { "&pageToken=${Uri.encode(it)}" } ?: "")
            val j = call(ctx, email, Request.Builder().url(url))
            val a = j.optJSONArray("files") ?: JSONArray()
            for (i in 0 until a.length()) {
                val f = a.getJSONObject(i)
                val mime = f.optString("mimeType")
                out += Item(f.getString("id"), f.optString("name"), mime, f.optString("size").toLongOrNull() ?: 0, mime == FOLDER)
            }
            page = j.optString("nextPageToken").ifBlank { null }
        } while (page != null && out.size < 3000)
        return out
    }

    fun mediaUrl(id: String) = "$API/files/$id?alt=media"
    fun uriOf(id: String, email: String): Uri = Uri.parse("cvgd://$id?a=${Uri.encode(email)}")

    fun isAudio(i: Item) = i.mime.startsWith("audio/") || i.name.substringAfterLast('.').lowercase() in
        setOf("mp3", "m4a", "aac", "flac", "ogg", "opus", "wav", "webm")

    fun isVideo(i: Item) = i.mime.startsWith("video/") || i.name.substringAfterLast('.').lowercase() in setOf("mp4", "mkv", "mov", "m4v")

    /* ---- tải lên */
    var uploading by mutableStateOf<String?>(null)
    var upDone by mutableStateOf(0)
    var upTotal by mutableStateOf(0)

    /** tải các bài trên điện thoại lên thư mục của tài khoản đang chọn (playlist → thư mục con). Trả về số bài lỗi. */
    suspend fun upload(ctx: Context, tracks: List<OTrack>, sub: String?): Int {
        val a = acc() ?: throw IOException("Chưa có tài khoản Google Drive")
        val root = a.folderId ?: ensureFolder(ctx, a.email, a.folderName ?: "CircleVault")
        val parent = if (sub != null) ensureFolder(ctx, a.email, sub, root) else root
        val existing = children(ctx, parent, a.email).map { it.name }.toSet()
        uploading = sub ?: "bài hát"
        upDone = 0
        upTotal = tracks.size
        var failed = 0
        try {
            for (t in tracks) {
                val f = File(t.path)
                val name = "${safeName(t.title)}.${f.extension}"
                if (name !in existing && f.exists()) {
                    runCatching { uploadFile(ctx, a.email, f, name, parent) }.onFailure { failed++ }
                }
                upDone++
            }
        } finally {
            uploading = null
        }
        return failed
    }

    private suspend fun uploadFile(ctx: Context, email: String, f: File, name: String, parent: String) = withContext(Dispatchers.IO) {
        val mime = android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(f.extension.lowercase()) ?: "application/octet-stream"
        val meta = JSONObject().put("name", name).put("parents", JSONArray(listOf(parent)))
        val start = Request.Builder().url("$UPLOAD?uploadType=resumable&fields=id")
            .header("Authorization", "Bearer ${token(ctx, email)}")
            .header("X-Upload-Content-Type", mime).header("X-Upload-Content-Length", f.length().toString())
            .post(meta.toString().toRequestBody("application/json; charset=UTF-8".toMediaType())).build()
        val loc = Api.http.newCall(start).execute().use { r ->
            if (!r.isSuccessful) throw IOException("Lỗi ${r.code}")
            r.header("Location") ?: throw IOException("Thiếu địa chỉ tải lên")
        }
        val put = Request.Builder().url(loc).put(f.asRequestBody(mime.toMediaType())).build()
        Api.http.newBuilder().writeTimeout(10, TimeUnit.MINUTES).readTimeout(2, TimeUnit.MINUTES).build()
            .newCall(put).execute().use { r -> if (!r.isSuccessful) throw IOException("Lỗi ${r.code}") }
    }
}
