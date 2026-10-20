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
        versionCode = 20001
        versionName = "2.0.1"
        // The repository whose CI built this app: the updater follows that project's releases (Updates.kt).
        buildConfigField("String", "UPDATE_REPO", "\"${System.getenv("GITHUB_REPOSITORY") ?: "InukaAsith/TwinDesk"}\"")
    }
    // Two builds of the same app (same id and signature, so one installs over the other):
    //   standard — what people download: no notification access, which Play Protect blocks on apps
    //              installed from a browser, a messaging app or a file manager;
    //   full     — with it (the phone's notifications on the computer): the computer installs it over
    //              the standard one through wireless debugging, which Play Protect doesn't check.
    flavorDimensions += "dist"
    productFlavors {
        create("standard") {
            dimension = "dist"
            buildConfigField("boolean", "NOTIF_LISTENER", "false")
        }
        create("full") {
            dimension = "dist"
            buildConfigField("boolean", "NOTIF_LISTENER", "true")
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
    testImplementation("junit:junit:4.13.2")
    // The Android stub jar throws on org.json in plain JVM tests; the real implementation goes first.
    testImplementation("org.json:json:20240303")
}
