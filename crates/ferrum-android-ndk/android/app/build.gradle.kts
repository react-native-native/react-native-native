plugins {
    id("com.android.application")
}

android {
    namespace = "com.ferrum.ndk"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.ferrum.ndk"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0-phase0-ndk"
        ndk { abiFilters += setOf("arm64-v8a") }
    }

    buildTypes {
        debug { isMinifyEnabled = false }
    }

    sourceSets {
        getByName("main") {
            jniLibs.srcDirs("src/main/jniLibs")
            assets.srcDirs("src/main/assets")
        }
    }

    packaging {
        jniLibs { useLegacyPackaging = false }
    }
}
