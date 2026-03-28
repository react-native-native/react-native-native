//! Build script for ferrum-android.

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
            // Static libs — linked into libferrum_android.so
            println!("cargo:rustc-link-lib=static=hermesabi");
            println!("cargo:rustc-link-lib=static=hermesvm_a");
            println!("cargo:rustc-link-lib=static=hermesVMRuntime");
            println!("cargo:rustc-link-lib=static=boost_context");
            // C++ standard library (Hermes internals)
            println!("cargo:rustc-link-lib=static=c++_static");
            println!("cargo:rustc-link-lib=static=c++abi");
            println!("cargo:warning=ferrum-android: linking Hermes from {lib_dir}");
        }
        Err(_) => {
            println!(
                "cargo:warning=ferrum-android: HERMES_ANDROID_LIB_DIR not set. \
                 Set to directory containing Hermes static libs."
            );
        }
    }
}

fn configure_android_linker_flags() {
    println!("cargo:rustc-link-lib=android");
    println!("cargo:rustc-link-lib=log");
}
