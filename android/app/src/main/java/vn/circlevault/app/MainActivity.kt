package vn.circlevault.app

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import vn.circlevault.app.ui.AppRoot
import vn.circlevault.app.ui.CvTheme

class MainActivity : ComponentActivity() {
    private val askNotify = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        PlayerConn.connect(this)
        // Thông báo: hiện tiến độ tải và nút điều khiển nhạc trên màn hình khóa
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            askNotify.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        setContent { CvTheme { AppRoot() } }
    }

    override fun onStart() {
        super.onStart()
        PlayerConn.connect(this)
    }

    override fun onDestroy() {
        if (isFinishing) PlayerConn.release()
        super.onDestroy()
    }
}
