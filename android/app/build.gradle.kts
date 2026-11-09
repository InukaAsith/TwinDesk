plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.twindesk.android"
    compileSdk = 37
    defaultConfig {
        applicationId = "com.twindesk.android"
        minSdk = 29 // Android 10: wireless debugging needs 11, everything else works from 10
        targetSdk = 36
        versionCode = 20600
        versionName = "2.6.0"
    }
    // Two builds of the same app (same id and signature, so one installs over the other):
    //   standard — what people download: no notification access, SMS or Accessibility service, which
    //              Play Protect blocks on apps installed from a browser, a messaging app or a file manager;
    //   full     — with them (notifications, Messages, the mouse and keyboard without ADB): the computer
    //              installs it over the standard one through wireless debugging, which Play Protect doesn't check.
    flavorDimensions += "dist"
    productFlavors {
        create("standard") {
            dimension = "dist"
            buildConfigField("boolean", "NOTIF_LISTENER", "false")
            buildConfigField("boolean", "ACCESSIBILITY", "false")
        }
        create("full") {
            dimension = "dist"
            buildConfigField("boolean", "NOTIF_LISTENER", "true")
            buildConfigField("boolean", "ACCESSIBILITY", "true")
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            // Sideloaded from GitHub releases: signed with this machine's debug key until a release key exists.
            signingConfig = signingConfigs.getByName("debug")
        }
    }
    lint {
        checkReleaseBuilds = false
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2026.09.00"))
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("com.squareup.okhttp3:okhttp:5.5.0")
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0") // Scan QR code (pairing): Google's scanner, no camera permission
}
