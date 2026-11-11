plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// CI truyền -PvName=2026.11.14 -PvCode=2611014; khóa ký qua biến môi trường CV_KEYSTORE / CV_KEYSTORE_PASS (giữ nguyên mãi mãi)
val vName = (findProperty("vName") as String?) ?: "0.0.1"
val vCode = ((findProperty("vCode") as String?) ?: "1").toInt()
val keystore = System.getenv("CV_KEYSTORE")?.takeIf { file(it).exists() }

android {
    namespace = "vn.circlevault.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "vn.circlevault.app"
        minSdk = 26
        targetSdk = 35
        versionCode = vCode
        versionName = vName
    }

    signingConfigs {
        if (keystore != null) {
            create("release") {
                storeFile = file(keystore)
                storePassword = System.getenv("CV_KEYSTORE_PASS")
                keyAlias = System.getenv("CV_KEY_ALIAS") ?: "circlevault"
                keyPassword = System.getenv("CV_KEYSTORE_PASS")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = if (keystore != null) signingConfigs.getByName("release") else signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        isCoreLibraryDesugaringEnabled = true          // NewPipeExtractor dùng API Java mới (URLEncoder…Charset) – Android < 13 cần
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    packaging { resources.excludes += "/META-INF/{AL2.0,LGPL2.1}" }
}

dependencies {
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs_nio:2.1.4")
    val composeBom = platform("androidx.compose:compose-bom:2024.12.01")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.fragment:fragment-ktx:1.8.5")   // play-services kéo theo bản cũ, ActivityResult cần ≥ 1.3
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")

    implementation("androidx.media3:media3-exoplayer:1.5.1")
    implementation("androidx.media3:media3-session:1.5.1")
    implementation("androidx.media3:media3-ui:1.5.1")
    implementation("androidx.media3:media3-transformer:1.5.1")   // cắt, ghép nhạc
    implementation("androidx.media3:media3-common:1.5.1")

    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("io.coil-kt:coil-compose:2.7.0")
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")
    implementation("com.google.android.gms:play-services-auth:21.2.0")                 // Google Drive: đăng nhập bằng tài khoản trên máy
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-play-services:1.9.0")
    implementation("androidx.work:work-runtime-ktx:2.10.0")              // kiểm tra bản mới định kỳ
    implementation("com.github.TeamNewPipe:NewPipeExtractor:v0.27.1")     // nghe YouTube trực tiếp khi máy tính tắt
}
