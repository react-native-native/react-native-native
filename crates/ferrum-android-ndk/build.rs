//! Build script for ferrum-android-ndk.
//!
//! Links Hermes static libraries and the required Android system libraries.
//! Set `HERMES_ANDROID_LIB_DIR` to the directory containing the Hermes
//! static archives before building.

fn main() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();

    if target_os == "android" {
        link_hermes_android();
        configure_android_linker_flags();
    }

    println!("cargo:rerun-if-env-changed=HERMES_ANDROID_LIB_DIR");
}

fn link_hermes_android() {
    match std::env::var("HERMES_ANDROID_LIB_DIR") {
        Ok(lib_dir) => {
            println!("cargo:rustc-link-search=native={lib_dir}");
            // Static Hermes archives — baked into libferrum_android_ndk.so
            println!("cargo:rustc-link-lib=static=hermesabi");
            println!("cargo:rustc-link-lib=static=hermesvm_a");
            println!("cargo:rustc-link-lib=static=hermesVMRuntime");
            println!("cargo:rustc-link-lib=static=boost_context");
            // Hermes internals require libc++_shared
            println!("cargo:rustc-link-lib=c++_shared");
            println!("cargo:warning=ferrum-android-ndk: linking Hermes from {lib_dir}");
        }
        Err(_) => {
            println!(
                "cargo:warning=ferrum-android-ndk: HERMES_ANDROID_LIB_DIR not set. \
                 Set to directory containing Hermes static libs \
                 (e.g. vendor/hermes/lib/android-arm64)."
            );
        }
    }
}

fn configure_android_linker_flags() {
    // `android` provides AAssetManager, AChoreographer, ALooper, etc.
    println!("cargo:rustc-link-lib=android");
    // `log` provides __android_log_print used by android_logger
    println!("cargo:rustc-link-lib=log");
}
