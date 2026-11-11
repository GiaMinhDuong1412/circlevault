package vn.circlevault.app.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/* Cùng bảng màu với app máy tính (frontend/css/app.css :root) */
data class CvColors(
    val bg: Color, val surface: Color, val surface2: Color, val ink: Color, val text: Color, val muted: Color,
    val cyan: Color, val yellow: Color, val green: Color, val pink: Color, val red: Color, val violet: Color,
    val onAccent: Color, val dark: Boolean,
)

val LightCv = CvColors(
    bg = Color(0xFFFBF9F4), surface = Color.White, surface2 = Color(0xFFF3F1EA), ink = Color(0xFF121212),
    text = Color(0xFF121212), muted = Color(0xFF5D5B55), cyan = Color(0xFF19BDE8), yellow = Color(0xFFFCC419),
    green = Color(0xFF3BE08C), pink = Color(0xFFF7A8EC), red = Color(0xFFFF5A5F), violet = Color(0xFF9B8CFF),
    onAccent = Color(0xFF121212), dark = false,
)
val DarkCv = LightCv.copy(
    bg = Color(0xFF131418), surface = Color(0xFF1D1F25), surface2 = Color(0xFF262830), ink = Color(0xFFE8E5DA),
    text = Color(0xFFF2F0EA), muted = Color(0xFFA9A69C), dark = true,
)
val LocalCv = staticCompositionLocalOf { LightCv }

@Composable
fun CvTheme(content: @Composable () -> Unit) {
    val c = if (isSystemInDarkTheme()) DarkCv else LightCv
    val scheme = if (c.dark) {
        darkColorScheme(primary = c.cyan, background = c.bg, surface = c.surface, onSurface = c.text, onBackground = c.text)
    } else {
        lightColorScheme(primary = Color(0xFF0E8FB3), background = c.bg, surface = c.surface, onSurface = c.text, onBackground = c.text)
    }
    CompositionLocalProvider(LocalCv provides c) { MaterialTheme(colorScheme = scheme, content = content) }
}

val cv: CvColors @Composable get() = LocalCv.current

/** Khung kiểu neo-brutalist: nền, viền đen dày, bóng cứng lệch xuống phải. */
fun Modifier.brutal(bg: Color, ink: Color, shadow: Dp = 4.dp, radius: Dp = 6.dp, border: Dp = 2.5.dp): Modifier {
    val shape = RoundedCornerShape(radius)
    return this
        .padding(end = shadow, bottom = shadow)
        .drawBehind {
            if (shadow > 0.dp) {
                val s = shadow.toPx()
                drawRoundRect(ink, topLeft = Offset(s, s), size = size, cornerRadius = CornerRadius(radius.toPx()))
            }
        }
        .clip(shape)
        .background(bg)
        .border(border, ink, shape)
}

@Composable
fun BButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    color: Color = cv.green,
    enabled: Boolean = true,
    small: Boolean = false,
    icon: ImageVector? = null,
) {
    val c = cv
    val plain = color == c.surface
    val fg = if (!enabled) c.muted else if (plain) c.text else c.onAccent
    Row(
        modifier
            .brutal(if (enabled) color else c.surface2, c.ink, shadow = if (small) 2.dp else 3.dp, radius = 4.dp, border = 2.dp)
            .clickable(enabled = enabled, onClick = onClick)
            .heightIn(min = if (small) 40.dp else 50.dp)
            .padding(horizontal = if (small) 12.dp else 16.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) {
            Icon(icon, null, tint = fg, modifier = Modifier.size(if (small) 18.dp else 20.dp))
            if (text.isNotEmpty()) Spacer(Modifier.width(6.dp))
        }
        if (text.isNotEmpty()) {
            Text(
                text, color = fg, fontWeight = FontWeight.Bold, fontSize = if (small) 14.sp else 16.sp,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
fun IconBtn(icon: ImageVector, desc: String, onClick: () -> Unit, color: Color = cv.yellow, enabled: Boolean = true) {
    val c = cv
    Box(
        Modifier
            .brutal(if (enabled) color else c.surface2, c.ink, shadow = 2.dp, radius = 4.dp, border = 2.dp)
            .clickable(enabled = enabled, onClick = onClick)
            .size(46.dp),
        contentAlignment = Alignment.Center,
    ) { Icon(icon, desc, tint = if (color == c.surface) c.text else c.onAccent, modifier = Modifier.size(22.dp)) }
}

@Composable
fun Card(modifier: Modifier = Modifier, color: Color = cv.surface, content: @Composable () -> Unit) {
    Column(
        modifier
            .fillMaxWidth()
            .brutal(color, cv.ink)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) { content() }
}

@Composable
fun H(text: String, modifier: Modifier = Modifier, size: Int = 18) =
    Text(text, modifier, color = cv.text, fontWeight = FontWeight.Black, fontSize = size.sp)

@Composable
fun Hint(text: String, modifier: Modifier = Modifier, color: Color = cv.muted) =
    Text(text, modifier, color = color, fontSize = 13.5.sp, lineHeight = 19.sp)

@Composable
fun Field(
    label: String, value: String, onChange: (String) -> Unit, placeholder: String = "",
    keyboard: KeyboardOptions = KeyboardOptions.Default, modifier: Modifier = Modifier,
) {
    val c = cv
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (label.isNotEmpty()) Text(label, color = c.text, fontWeight = FontWeight.Bold, fontSize = 14.sp)
        BasicTextField(
            value, onChange, singleLine = true, keyboardOptions = keyboard,
            textStyle = TextStyle(color = c.text, fontSize = 16.sp),
            cursorBrush = SolidColor(c.text),
            decorationBox = { inner ->
                Box(
                    Modifier
                        .fillMaxWidth()
                        .brutal(c.surface, c.ink, shadow = 0.dp, radius = 6.dp, border = 2.5.dp)
                        .heightIn(min = 50.dp)
                        .padding(horizontal = 14.dp, vertical = 13.dp),
                    contentAlignment = Alignment.CenterStart,
                ) {
                    if (value.isEmpty()) Text(placeholder, color = c.muted, fontSize = 16.sp)
                    inner()
                }
            },
        )
    }
}

/** Thanh tiến độ phẳng có viền. */
@Composable
fun Bar(frac: Float, modifier: Modifier = Modifier, color: Color = cv.green) {
    val c = cv
    Canvas(modifier.fillMaxWidth().heightIn(min = 10.dp).padding(vertical = 2.dp)) {
        val r = CornerRadius(3.dp.toPx())
        drawRoundRect(c.surface2, cornerRadius = r)
        drawRoundRect(color, size = Size(size.width * frac.coerceIn(0f, 1f), size.height), cornerRadius = r)
        drawRoundRect(c.ink, cornerRadius = r, style = Stroke(1.5.dp.toPx()))
    }
}

/** Logo CircleVault: ô màu xoay vòng + vòng tròn trắng. */
@Composable
fun Logo(modifier: Modifier = Modifier) {
    val c = cv
    Canvas(modifier.size(40.dp)) {
        val r = CornerRadius(6.dp.toPx())
        val s = 3.dp.toPx()
        val box = Size(size.width - s, size.height - s)
        drawRoundRect(c.ink, topLeft = Offset(s, s), size = box, cornerRadius = r)
        drawRoundRect(
            Brush.sweepGradient(listOf(c.red, c.yellow, c.cyan, c.red), center = Offset(box.width / 2, box.height / 2)),
            size = box, cornerRadius = r,
        )
        drawRoundRect(c.ink, size = box, cornerRadius = r, style = Stroke(2.5.dp.toPx()))
        drawCircle(Color.White, radius = box.width * 0.2f, center = Offset(box.width / 2, box.height / 2))
        drawCircle(c.ink, radius = box.width * 0.2f, center = Offset(box.width / 2, box.height / 2), style = Stroke(2.5.dp.toPx()))
    }
}

/* Biểu tượng (đường vẽ theo bộ Material, tự khai báo để app gọn nhẹ) */
private fun ic(name: String, path: String) = ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f)
    .addPath(addPathNodes(path), fill = SolidColor(Color.Black)).build()

object Ic {
    val play = ic("play", "M8,5v14l11,-7z")
    val pause = ic("pause", "M6,19h4V5H6v14zM14,5v14h4V5h-4z")
    val next = ic("next", "M6,18l8.5,-6L6,6v12zM16,6v12h2V6h-2z")
    val prev = ic("prev", "M6,6h2v12H6zM9.5,12l8.5,6V6z")
    val download = ic("download", "M19,9h-4V3H9v6H5l7,7 7,-7zM5,18v2h14v-2H5z")
    val delete = ic("delete", "M6,19c0,1.1 0.9,2 2,2h8c1.1,0 2,-0.9 2,-2V7H6v12zM19,4h-3.5l-1,-1h-5l-1,1H5v2h14V4z")
    val check = ic("check", "M9,16.17L4.83,12l-1.42,1.41L9,19 21,7l-1.41,-1.41z")
    val close = ic("close", "M19,6.41L17.59,5 12,10.59 6.41,5 5,6.41 10.59,12 5,17.59 6.41,19 12,13.41 17.59,19 19,17.59 13.41,12z")
    val music = ic("music", "M12,3v10.55c-0.59,-0.34 -1.27,-0.55 -2,-0.55 -2.21,0 -4,1.79 -4,4s1.79,4 4,4 4,-1.79 4,-4V7h4V3h-6z")
    val movie = ic("movie", "M18,4l2,4h-3l-2,-4h-2l2,4h-3l-2,-4H8l2,4H7L5,4H4c-1.1,0 -1.99,0.9 -1.99,2L2,18c0,1.1 0.9,2 2,2h16c1.1,0 2,-0.9 2,-2V4h-4z")
    val refresh = ic("refresh", "M17.65,6.35C16.2,4.9 14.21,4 12,4c-4.42,0 -7.99,3.58 -7.99,8s3.57,8 7.99,8c3.73,0 6.84,-2.55 7.73,-6h-2.08c-0.82,2.33 -3.04,4 -5.65,4 -3.31,0 -6,-2.69 -6,-6s2.69,-6 6,-6c1.66,0 3.14,0.69 4.22,1.78L13,11h7V4l-2.35,2.35z")
    val qr = ic("qr", "M3,11h8V3H3v8zM5,5h4v4H5V5zM3,21h8v-8H3v8zM5,15h4v4H5v-4zM13,3v8h8V3h-8zM19,9h-4V5h4v4zM19,19h2v2h-2zM13,13h2v2h-2zM15,15h2v2h-2zM13,17h2v2h-2zM15,19h2v2h-2zM17,17h2v2h-2zM17,13h2v2h-2zM19,15h2v2h-2z")
    val down = ic("down", "M7.41,8.59L12,13.17l4.59,-4.58L18,10l-6,6 -6,-6 1.41,-1.41z")
    val up = ic("up", "M7.41,15.41L12,10.83l4.59,4.58L18,14l-6,-6 -6,6z")
    val back = ic("back", "M20,11H7.83l5.59,-5.59L12,4l-8,8 8,8 1.41,-1.41L7.83,13H20v-2z")
}
