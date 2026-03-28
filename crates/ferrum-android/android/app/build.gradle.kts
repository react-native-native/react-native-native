// ferrum-android/android/app/build.gradle.kts
//
// Gradle build file for the Ferrum Phase 0 Android application module.
//
// This build file does NOT invoke Cargo — Rust compilation is handled
// separately via `cargo ndk` (see build.sh or Makefile). The Rust-built
// libferrum_android.so is expected to be present in:
//   src/main/jniLibs/arm64-v8a/libferrum_android.so
//
// before `./gradlew assembleDebug` is run.
//
// Separation of concerns:
//   - Rust build: cargo ndk (cross-compiles .so for aarch64-linux-android)
//   - Android build: Gradle (packages the .so into the APK)
//
// If you want Gradle to trigger Cargo automatically, add a Gradle task that
// invokes `cargo ndk` before the `preBuild` task. This is convenient for CI
// but adds Rust toolchain requirements to the Gradle environment.

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.ferrum.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.ferrum.app"
        minSdk = 26          // API 26 (Android 8.0): safe baseline for 2026 devices
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0-phase0"

        // Only build for 64-bit ARM. 32-bit Android is effectively deprecated
        // for new development targeting physical devices in 2026.
        ndk {
            abiFilters += setOf("arm64-v8a")
        }
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
            // Include the debug .so built by: cargo ndk -t arm64-v8a build
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            // Include the release .so built by: cargo ndk -t arm64-v8a build --release
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    sourceSets {
        getByName("main") {
            // Rust-built .so files are expected here before Gradle runs.
            jniLibs.srcDirs("src/main/jniLibs")
            // JS bundle and other assets loaded by Rust via AssetManager.
            assets.srcDirs("src/main/assets")
        }
    }

    packaging {
        jniLibs {
            // Keep the .so files uncompressed in the APK for faster dlopen.
            // Compressed .so requires extraction to disk; uncompressed maps directly.
            useLegacyPackaging = false
        }
    }
}

dependencies {
    // Minimal dependencies: no React Native, no Expo, no module system.
    // The Kotlin Activity is intentionally thin — all work happens in Rust.
    implementation("androidx.core:core-ktx:1.12.0")
}

// ---------------------------------------------------------------------------
// Optional: Gradle task that invokes cargo ndk before building
// ---------------------------------------------------------------------------
//
// Uncomment to have Gradle automatically rebuild the Rust .so on each build.
// Requires `cargo-ndk` on PATH: `cargo install cargo-ndk`
//
// tasks.register<Exec>("buildRust") {
//     workingDir = File(rootDir, "../../..")   // ferrum workspace root
//     commandLine(
//         "cargo", "ndk",
//         "-t", "arm64-v8a",
//         "-o", "${projectDir}/src/main/jniLibs",
//         "build"
//     )
// }
//
// tasks.named("preBuild") { dependsOn("buildRust") }
