package vn.circlevault.app

import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.ResolvingDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.MediaController
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import java.io.File

/** Phát nhạc nền: thông báo có nút điều khiển, màn hình khóa, tự dừng khi rút tai nghe. */
class PlaybackService : MediaSessionService() {
    private var session: MediaSession? = null

    override fun onCreate() {
        super.onCreate()
        // cvyt://<id> → link thật lúc phát (qua máy tính hoặc tự lấy); file trong máy đi thẳng
        val http = DefaultHttpDataSource.Factory().setAllowCrossProtocolRedirects(true).setConnectTimeoutMs(10_000)
        val resolving = ResolvingDataSource.Factory(DefaultDataSource.Factory(this, http)) { spec: DataSpec ->
            if (spec.uri.scheme == "cvgd") {         // file nhạc trên Google Drive
                val email = spec.uri.getQueryParameter("a") ?: Drive.active
                val tk = try {
                    Drive.tokenBlocking(this, email)
                } catch (e: Throwable) {
                    throw java.io.IOException("Cần cấp quyền Google Drive lại (mở tab Online → Drive).", e)
                }
                spec.buildUpon().setUri(Uri.parse(Drive.mediaUrl(spec.uri.host ?: "")))
                    .setHttpRequestHeaders(spec.httpRequestHeaders + mapOf("Authorization" to "Bearer $tk")).build()
            } else if (spec.uri.scheme == "cvyt") {
                val r = try {
                    YouTube.resolve(spec.uri.host ?: "")
                } catch (e: Throwable) {
                    throw java.io.IOException("Không lấy được bài từ YouTube: ${e.message}", e)    // trình phát báo lỗi, không văng app
                }
                spec.buildUpon().setUri(Uri.parse(r.url)).setHttpRequestHeaders(spec.httpRequestHeaders + r.headers).build()
            } else spec
        }
        val player = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(resolving))
            .setAudioAttributes(
                AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), true,
            )
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .build()
        // bộ chỉnh âm: gắn vào phiên âm thanh của trình phát, đổi bài thì áp EQ riêng của bài (nếu có)
        Eq.attach(player.audioSessionId)
        player.addListener(object : Player.Listener {
            override fun onAudioSessionIdChanged(audioSessionId: Int) = Eq.attach(audioSessionId)
            override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) = Eq.onTrack(mediaItem?.mediaId)
        })
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        session = MediaSession.Builder(this, player)
            .setSessionActivity(open)
            .setCallback(object : MediaSession.Callback {
                // Bài gửi từ giao diện sang mang đường dẫn file trong requestMetadata → gắn lại vào MediaItem
                override fun onAddMediaItems(
                    mediaSession: MediaSession, controller: MediaSession.ControllerInfo, mediaItems: MutableList<MediaItem>,
                ): ListenableFuture<MutableList<MediaItem>> = Futures.immediateFuture(
                    mediaItems.map { item ->
                        val uri = item.requestMetadata.mediaUri ?: item.localConfiguration?.uri
                        if (uri != null) item.buildUpon().setUri(uri).build() else item
                    }.toMutableList(),
                )
            })
            .build()
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

    override fun onTaskRemoved(rootIntent: Intent?) {
        val p = session?.player
        if (p == null || !p.playWhenReady || p.mediaItemCount == 0) stopSelf()
    }

    override fun onDestroy() {
        Eq.release()
        session?.run {
            player.release()
            release()
        }
        session = null
        super.onDestroy()
    }
}

/** Giao diện nói chuyện với PlaybackService qua MediaController. */
object PlayerConn {
    var controller by mutableStateOf<MediaController?>(null)
        private set

    fun connect(ctx: Context) {
        if (controller != null) return
        val token = SessionToken(ctx, ComponentName(ctx, PlaybackService::class.java))
        val f = MediaController.Builder(ctx, token).buildAsync()
        f.addListener({ controller = runCatching { f.get() }.getOrNull() }, ContextCompat.getMainExecutor(ctx))
    }

    fun release() {
        controller?.release()
        controller = null
    }

    fun play(tracks: List<OTrack>, start: Int) = playItems(tracks.map { it.toItem() }, start)

    /** phát danh sách YouTube: bài đã lưu về máy thì phát file, chưa thì phát online */
    fun playOnline(tracks: List<OnlineTrack>, start: Int) = playItems(
        tracks.map { t -> Store.byYt(t.yt)?.toItem() ?: t.toItem() }, start,
    )

    private fun playItems(items: List<MediaItem>, start: Int) {
        val c = controller ?: return
        if (items.isEmpty()) return
        c.setMediaItems(items, start.coerceIn(0, items.size - 1), 0)
        c.prepare()
        c.play()
    }

    /** phát file nhạc trên Google Drive (bài đã tải về máy thì phát file) */
    fun playDrive(items: List<Drive.Item>, email: String, start: Int) = playItems(
        items.map { i ->
            Store.byGd(i.id)?.toItem() ?: run {
                val uri = Drive.uriOf(i.id, email)
                MediaItem.Builder().setMediaId("g${i.id}").setUri(uri)
                    .setRequestMetadata(MediaItem.RequestMetadata.Builder().setMediaUri(uri).build())
                    .setMediaMetadata(MediaMetadata.Builder().setTitle(i.name.substringBeforeLast('.')).setArtist("Google Drive").build())
                    .build()
            }
        },
        start,
    )

    /** bài đang phát có phải bài YouTube online (chưa lưu) không → hiện nút Lưu */
    fun currentOnline(): OnlineTrack? {
        val m = controller?.currentMediaItem ?: return null
        if (!m.mediaId.startsWith("y")) return null
        val md = m.mediaMetadata
        return OnlineTrack(m.mediaId.drop(1), md.title?.toString() ?: "", md.artist?.toString(), 0.0, md.artworkUri?.toString())
    }
}

fun OTrack.toItem(): MediaItem {
    val uri = Uri.fromFile(File(path))
    return MediaItem.Builder()
        .setMediaId("t$id")
        .setUri(uri)
        .setRequestMetadata(MediaItem.RequestMetadata.Builder().setMediaUri(uri).build())
        .setMediaMetadata(
            MediaMetadata.Builder()
                .setTitle(title)
                .setArtist(artist)
                .setArtworkUri(cover?.let { Uri.fromFile(File(it)) })
                .build(),
        )
        .build()
}

fun OnlineTrack.toItem(): MediaItem {
    val uri = YouTube.uriOf(yt)
    return MediaItem.Builder()
        .setMediaId("y$yt")
        .setUri(uri)
        .setRequestMetadata(MediaItem.RequestMetadata.Builder().setMediaUri(uri).build())
        .setMediaMetadata(
            MediaMetadata.Builder().setTitle(title).setArtist(artist).setArtworkUri(thumb?.let { Uri.parse(it) }).build(),
        )
        .build()
}
