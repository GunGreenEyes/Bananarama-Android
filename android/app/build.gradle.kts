plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Whole-number versions come from ../package.json: "2.0.0" -> versionCode 2, versionName "v2".
val major: Int = Regex("\"version\"\\s*:\\s*\"(\\d+)")
    .find(rootProject.file("../package.json").readText())!!.groupValues[1].toInt()

android {
    namespace = "com.gungreeneyes.bananarama"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.gungreeneyes.bananarama"
        minSdk = 26
        targetSdk = 35
        versionCode = major
        versionName = "v$major"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    // Release signing: CI writes the keystore from the ANDROID_SIGNING_KEY secret and sets
    // BANANARAMA_KEYSTORE. Without it, release builds fall back to the debug key (for testing only).
    val keystore = System.getenv("BANANARAMA_KEYSTORE")
    signingConfigs {
        if (keystore != null) create("release") {
            storeFile = file(keystore)
            storeType = "PKCS12"
            storePassword = System.getenv("BANANARAMA_KEYSTORE_PASSWORD") ?: "bananarama"
            keyAlias = "bananarama"
            keyPassword = storePassword
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = if (keystore != null) signingConfigs.getByName("release") else signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures { buildConfig = true }
    testOptions { unitTests.isReturnDefaultValues = true }
}

kotlin { jvmToolchain(17) }

dependencies {
    implementation(project(":core"))
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test:core:1.6.1")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
}
