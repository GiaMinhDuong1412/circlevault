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
import androidx.compose.foundation.layout.height
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
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

private fun pal(
    bg: Long, surface: Long, surface2: Long, ink: Long, muted: Long, cyan: Long, yellow: Long, green: Long, pink: Long,
    red: Long, violet: Long, dark: Boolean, text: Long = ink,
) = CvColors(
    Color(bg), Color(surface), Color(surface2), Color(ink), Color(text), Color(muted), Color(cyan), Color(yellow),
    Color(green), Color(pink), Color(red), Color(violet), Color(0xFF121212), dark,
)

/** Theme giống app máy tính (app.js THEMES); "" = theo hệ thống (sáng/tối) */
val THEMES: List<Triple<String, String, CvColors>> = listOf(
    Triple("sang", "Sáng", LightCv),
    Triple("dark", "Tối", DarkCv),
    Triple("hong", "Hồng", pal(0xFFFFF5FA, 0xFFFFFFFF, 0xFFFDE6F2, 0xFF2A1230, 0xFF7A5A78, 0xFFFF9ACB, 0xFFFFE27A, 0xFF8FF0C4, 0xFFCDB0FF, 0xFFFF5A7A, 0xFFB48CFF, false)),
    Triple("bien", "Biển", pal(0xFFF1F7FC, 0xFFFFFFFF, 0xFFE1EEF8, 0xFF0B2233, 0xFF4F6B7D, 0xFF5CB8FF, 0xFF8AE9FB, 0xFF62E3BB, 0xFFA9BFFF, 0xFFFF6B6B, 0xFF96A1FF, false)),
    Triple("hoang-hon", "Hoàng hôn", pal(0xFFFFF4EA, 0xFFFFFAF5, 0xFFFDE3CF, 0xFF2B1608, 0xFF80604C, 0xFFFF8A5C, 0xFFFFD25E, 0xFFB9E68F, 0xFFF79BBD, 0xFFE63946, 0xFFC39BFF, false)),
    Triple("ca-phe", "Cà phê", pal(0xFFF5EDE3, 0xFFFFFAF3, 0xFFEADCC8, 0xFF2E1D12, 0xFF76604F, 0xFFD2AB82, 0xFFF2CB7D, 0xFFB0CF86, 0xFFE8B7A3, 0xFFD9534F, 0xFFBBA2CF, false)),
    Triple("rung", "Rừng đêm", pal(0xFF0F1A14, 0xFF16241C, 0xFF1F3127, 0xFFD6E8D6, 0xFF9DB5A2, 0xFF7FD893, 0xFFE8D26E, 0xFF55D98F, 0xFFC6E67F, 0xFFFF7A6B, 0xFFA7CDB0, true, text = 0xFFECF5EC)),
    Triple("neon", "Neon", pal(0xFF0D0B1A, 0xFF161329, 0xFF221C3E, 0xFFE4DDFF, 0xFFA79ED2, 0xFF22E4FF, 0xFFF7F56B, 0xFF3DFF8E, 0xFFFF5AD9, 0xFFFF4D6D, 0xFFB68CFF, true, text = 0xFFF4F1FF)),
)

object ThemeState {
    var key by androidx.compose.runtime.mutableStateOf(vn.circlevault.app.Prefs.theme)
    fun set(k: String) {
        key = k
        vn.circlevault.app.Prefs.theme = k
    }
}

@Composable
fun CvTheme(content: @Composable () -> Unit) {
    val sys = isSystemInDarkTheme()
    val c = THEMES.firstOrNull { it.first == ThemeState.key }?.third ?: if (sys) DarkCv else LightCv
    val scheme = if (c.dark) {
        darkColorScheme(primary = c.cyan, background = c.bg, surface = c.surface, onSurface = c.text, onBackground = c.text)
    } else {
        lightColorScheme(primary = c.ink, background = c.bg, surface = c.surface, onSurface = c.text, onBackground = c.text)
    }
    CompositionLocalProvider(LocalCv provides c) { MaterialTheme(colorScheme = scheme, content = content) }
}

val cv: CvColors @Composable get() = LocalCv.current

/** Khung kiểu neo-brutalist: nền, viền đen dày, bóng cứng lệch xuống phải. */
/** Kiểu giao diện giống app máy tính. Đọc MỘT LẦN khi mở app (đổi kiểu → khởi động lại). */
object UiStyle {
    val key: String by lazy { vn.circlevault.app.Prefs.uiStyle.ifBlank { "brutal" } }
    val rk: Float get() = when (key) { "tron" -> 2.6f; "mem" -> 2.4f; "phang" -> 1.4f; "kinh" -> 3f; else -> 1f }
    val soft: Boolean get() = key == "mem" || key == "phang" || key == "kinh"
}
val STYLES = listOf(
    Triple("brutal", "Neo-brutalist", "Viền đậm, bóng cứng"),
    Triple("tron", "Brutal bo tròn", "Viền đậm, góc tròn"),
    Triple("mem", "Mềm mại", "Viền mảnh, bóng mờ"),
    Triple("phang", "Tối giản", "Phẳng, không bóng"),
    Triple("kinh", "Kính mờ", "Trong suốt, nền chuyển màu"),
)

fun Modifier.brutal(bg: Color, ink: Color, shadow: Dp = 4.dp, radius: Dp = 6.dp, border: Dp = 2.5.dp): Modifier {
    val st = UiStyle.key
    val r = radius * UiStyle.rk
    val shape = RoundedCornerShape(r)
    val soft = UiStyle.soft
    val line = if (soft) ink.copy(alpha = if (st == "phang") 0.24f else 0.16f) else ink
    val bw = if (soft && border > 0.dp) 1.dp else border
    val fill = if (st == "kinh") bg.copy(alpha = bg.alpha * 0.8f) else bg
    return this
        .padding(end = shadow, bottom = shadow)
        .drawBehind {
            if (shadow > 0.dp && st != "phang") {
                val s = shadow.toPx()
                val cr = CornerRadius(r.toPx())
                if (soft) {                 // bóng mờ: 2 lớp lệch xuống
                    drawRoundRect(Color.Black.copy(alpha = 0.06f), topLeft = Offset(0f, s * 1.1f), size = size, cornerRadius = cr)
                    drawRoundRect(Color.Black.copy(alpha = 0.08f), topLeft = Offset(0f, s * 0.5f), size = size, cornerRadius = cr)
                } else {
                    drawRoundRect(ink, topLeft = Offset(s, s), size = size, cornerRadius = cr)
                }
            }
        }
        .clip(shape)
        .background(fill)
        .border(bw, line, shape)
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
    actions: androidx.compose.foundation.text.KeyboardActions = androidx.compose.foundation.text.KeyboardActions.Default,
) {
    val c = cv
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (label.isNotEmpty()) Text(label, color = c.text, fontWeight = FontWeight.Bold, fontSize = 14.sp)
        BasicTextField(
            value, onChange, singleLine = true, keyboardOptions = keyboard, keyboardActions = actions,
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
    Canvas(modifier.fillMaxWidth().padding(vertical = 2.dp).height(12.dp)) {
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
    val settings = ic("settings", "M19.14,12.94c0.04,-0.3 0.06,-0.61 0.06,-0.94c0,-0.32 -0.02,-0.64 -0.07,-0.94l2.03,-1.58c0.18,-0.14 0.23,-0.41 0.12,-0.61l-1.92,-3.32c-0.12,-0.22 -0.37,-0.29 -0.59,-0.22l-2.39,0.96c-0.5,-0.38 -1.03,-0.7 -1.62,-0.94L14.4,2.81c-0.04,-0.24 -0.24,-0.41 -0.48,-0.41h-3.84c-0.24,0 -0.43,0.17 -0.47,0.41L9.25,5.35C8.66,5.59 8.12,5.92 7.63,6.29L5.24,5.33c-0.22,-0.08 -0.47,0 -0.59,0.22L2.74,8.87C2.62,9.08 2.66,9.34 2.86,9.48l2.03,1.58C4.84,11.36 4.8,11.69 4.8,12s0.02,0.64 0.07,0.94l-2.03,1.58c-0.18,0.14 -0.23,0.41 -0.12,0.61l1.92,3.32c0.12,0.22 0.37,0.29 0.59,0.22l2.39,-0.96c0.5,0.38 1.03,0.7 1.62,0.94l0.36,2.54c0.05,0.24 0.24,0.41 0.48,0.41h3.84c0.24,0 0.44,-0.17 0.47,-0.41l0.36,-2.54c0.59,-0.24 1.13,-0.56 1.62,-0.94l2.39,0.96c0.22,0.08 0.47,0 0.59,-0.22l1.92,-3.32c0.12,-0.22 0.07,-0.47 -0.12,-0.61L19.14,12.94zM12,15.6c-1.98,0 -3.6,-1.62 -3.6,-3.6s1.62,-3.6 3.6,-3.6s3.6,1.62 3.6,3.6S13.98,15.6 12,15.6z")
    val more = ic("more", "M12,8c1.1,0 2,-0.9 2,-2s-0.9,-2 -2,-2 -2,0.9 -2,2 0.9,2 2,2zM12,10c-1.1,0 -2,0.9 -2,2s0.9,2 2,2 2,-0.9 2,-2 -0.9,-2 -2,-2zM12,16c-1.1,0 -2,0.9 -2,2s0.9,2 2,2 2,-0.9 2,-2 -0.9,-2 -2,-2z")
    val cut = ic("cut", "M9.64,7.64c0.23,-0.5 0.36,-1.05 0.36,-1.64 0,-2.21 -1.79,-4 -4,-4S2,3.79 2,6s1.79,4 4,4c0.59,0 1.14,-0.13 1.64,-0.36L10,12l-2.36,2.36C7.14,14.13 6.59,14 6,14c-2.21,0 -4,1.79 -4,4s1.79,4 4,4 4,-1.79 4,-4c0,-0.59 -0.13,-1.14 -0.36,-1.64L12,14l7,7h3v-1L9.64,7.64zM6,8c-1.1,0 -2,-0.89 -2,-2s0.9,-2 2,-2 2,0.89 2,2 -0.9,2 -2,2zM6,20c-1.1,0 -2,-0.89 -2,-2s0.9,-2 2,-2 2,0.89 2,2 -0.9,2 -2,2zM19,3l-6,6 2,2 7,-7V3z")
    val merge = ic("merge", "M17,20.41L18.41,19 15,15.59 13.59,17 17,20.41zM7.5,8H11v5.59L5.59,19 7,20.41l6,-6V8h3.5L12,3.5 7.5,8z")
    val eq = ic("eq", "M10,20h4V4h-4v16zM4,20h4v-8H4v8zM16,9v11h4V9h-4z")
    val search = ic("search", "M15.5,14h-0.79l-0.28,-0.27C15.41,12.59 16,11.11 16,9.5 16,5.91 13.09,3 9.5,3S3,5.91 3,9.5 5.91,16 9.5,16c1.61,0 3.09,-0.59 4.23,-1.57l0.27,0.28v0.79l5,4.99L20.49,19l-4.99,-5zM9.5,14C7.01,14 5,11.99 5,9.5S7.01,5 9.5,5 14,7.01 14,9.5 11.99,14 9.5,14z")
}
