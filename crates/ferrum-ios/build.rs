//! Build script for ferrum-ios.
//!
//! Responsibilities:
//! 1. Link against UIKit, Foundation, and QuartzCore frameworks.
//! 2. Link against the Hermes static library when available (controlled by the
//!    `HERMES_LIB_DIR` environment variable).
//! 3. Emit `cargo:rerun-if-changed` directives so incremental builds work.

fn main() {
    // Only relevant when building for iOS targets.
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();

    if target_os == "ios" {
        link_ios_frameworks();
        link_hermes_if_available();
    }

    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=HERMES_LIB_DIR");
}

/// Links the iOS system frameworks required by ferrum-ios.
///
/// - `UIKit`: UIApplication, UIWindow, UIViewController, UILabel
/// - `Foundation`: NSRunLoop, NSBundle, NSString
/// - `QuartzCore`: CADisplayLink, CALayer
fn link_ios_frameworks() {
    println!("cargo:rustc-link-lib=framework=UIKit");
    println!("cargo:rustc-link-lib=framework=Foundation");
    println!("cargo:rustc-link-lib=framework=QuartzCore");
}

/// Links the Hermes static library if `HERMES_LIB_DIR` is set.
///
/// Hermes precompiled static libraries for iOS are distributed by Meta as part
/// of the React Native release artifacts. For Phase 0 development you can
/// obtain them via:
///
/// ```sh
/// # From the RN npm package (after npm install react-native):
/// node_modules/react-native/sdks/hermes/build_apple/hermes/build_Release/
///   └── API/hermes/libhermes.a         ← fat library (arm64 + x86_64)
/// ```
///
/// Set `HERMES_LIB_DIR` to the directory containing `libhermes.a` before
/// running `cargo build --target aarch64-apple-ios`.
///
/// TODO(Phase 0, task 1): once `hermes-abi-rs` lands, this path will be read
/// from that crate's build script output instead of a bare env var.
fn link_hermes_if_available() {
    if let Ok(hermes_dir) = std::env::var("HERMES_LIB_DIR") {
        println!("cargo:rustc-link-search=native={hermes_dir}");
        // hermesabi: C ABI vtable (get_hermes_abi_vtable)
        println!("cargo:rustc-link-lib=static=hermesabi");
        // hermesvm_a: full Hermes VM as static archive
        println!("cargo:rustc-link-lib=static=hermesvm_a");
        // hermesVMRuntime: VM runtime support
        println!("cargo:rustc-link-lib=static=hermesVMRuntime");
        // boost_context: fiber/coroutine support used by Hermes StackExecutor
        println!("cargo:rustc-link-lib=static=boost_context");
        // C++ standard library required by Hermes internals
        println!("cargo:rustc-link-lib=c++");
        println!(
            "cargo:warning=ferrum-ios: linking Hermes from HERMES_LIB_DIR={hermes_dir}"
        );
    } else {
        println!(
            "cargo:warning=ferrum-ios: HERMES_LIB_DIR not set — \
             Hermes functions will be unresolved until hermes-abi-rs provides them. \
             Set HERMES_LIB_DIR to the directory containing libhermes.a to link now."
        );
    }
}
