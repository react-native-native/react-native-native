//! ferrum-ios — iOS bootstrap for Project Ferrum.
//!
//! This crate compiles to `libferrum_ios.a` (a static library) and is linked
//! into the `Ferrum.app` bundle by the Xcode project in `crates/ferrum-ios/ios/`.
//!
//! # Bootstrap sequence
//!
//! 1. Xcode calls the C `main()` provided by this crate (see `lib.rs`).
//! 2. `main()` calls `UIApplicationMain` to start the iOS run loop.
//! 3. `AppDelegate::applicationDidFinishLaunching` creates a `FerumRuntime`
//!    (stubbed until `ferrum-core` lands), registers `rust_add`, and evaluates
//!    the JS bundle.
//! 4. A `CADisplayLink` is created on the main thread and begins firing at the
//!    screen refresh rate.
//!
//! # Threading model
//!
//! `UIApplicationMain` blocks the calling thread (the main thread) and drives
//! the `CFRunLoop`. All `AppDelegate` callbacks execute on the main thread.
//! `CADisplayLink` selectors also fire on the main thread's run loop.
//!
//! If Hermes evaluation needs to run on a background thread, dispatch it via
//! `DispatchQueue.global()` from within `applicationDidFinishLaunching`, then
//! post results back to the main queue via `DispatchQueue.main`. See `NOTES.md`
//! for the full threading analysis.

#![warn(clippy::all, clippy::pedantic)]

use std::sync::atomic::AtomicI64;
#[cfg(test)]
use std::sync::atomic::Ordering;
use std::sync::OnceLock;

mod app_delegate;
mod display_link;
mod runtime;

pub use app_delegate::AppDelegate;
pub use display_link::FerrumDisplayLink;
pub use runtime::bootstrap_ferrum_runtime;

// Re-export the C FFI bridge so symbols appear in libferrum_ios.a.
pub use ferrum_core::bridge::ferrum_register_globals;

/// Global frame counter incremented by the CADisplayLink callback.
/// Phase 1 will use this to drive the Hermes `requestAnimationFrame` scheduler.
pub(crate) static FRAME_COUNTER: AtomicI64 = AtomicI64::new(0);

/// Global storage for initialisation state.
/// The OnceLock ensures we never double-initialise the Ferrum runtime.
pub(crate) static FERRUM_INIT: OnceLock<String> = OnceLock::new();

// ---------------------------------------------------------------------------
// C entry point — called by the OS loader before UIApplicationMain
// ---------------------------------------------------------------------------

/// C `main` entry point for the iOS binary.
///
/// iOS requires a C `main` function. We provide one here that immediately
/// calls `UIApplicationMain`, handing process ownership to the UIKit run loop.
/// The application delegate class name is registered via the `AppDelegate`
/// type below.
///
/// # Safety
///
/// This function is called by the OS with valid C `argc`/`argv` pointers.
/// `UIApplicationMain` is called with the correct class names and never
/// returns under normal operation.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn main(argc: std::ffi::c_int, argv: *mut *mut std::ffi::c_char) -> std::ffi::c_int {
    // Initialize os_log routing for the `log` crate before any log! calls.
    init_logging();

    log::info!("ferrum-ios: main() entered");

    // Phase 0 proof: evaluate JS bundle with Hermes BEFORE touching UIKit.
    // This way we get the result even if UIApplicationMain has issues.
    run_phase0_proof();

    // Hand off to UIKit run loop for display link testing.
    log::info!("ferrum-ios: handing off to UIApplicationMain");
    // SAFETY: UIApplicationMain is called with valid argc/argv from the OS.
    unsafe { app_delegate::run_application(argc, argv) }
}

// ---------------------------------------------------------------------------
// Phase 0 proof — Hermes evaluation without UIKit
// ---------------------------------------------------------------------------

fn run_phase0_proof() {
    // Load bundle.js from the app bundle
    let bundle_bytes = match load_bundle_js() {
        Ok(bytes) => bytes,
        Err(e) => {
            log::error!("ferrum-ios: failed to load bundle.js: {e}");
            // Fall back to inline JS
            b"var result = rust_add(40, 2); print('rust_add(40, 2) = ' + result); result;".to_vec()
        }
    };

    match bootstrap_ferrum_runtime(&bundle_bytes) {
        Ok(result) => {
            log::info!("=== PHASE 0 PROOF: Hermes evaluation succeeded ===");
            log::info!("=== Result: {result} ===");
        }
        Err(e) => {
            log::error!("=== PHASE 0 PROOF FAILED: {e} ===");
        }
    }
}

fn load_bundle_js() -> Result<Vec<u8>, String> {
    use objc2_foundation::{NSBundle, NSString};

    let main_bundle = NSBundle::mainBundle();
    let resource_name = NSString::from_str("bundle");
    let resource_type = NSString::from_str("js");

    let path: Option<objc2::rc::Retained<NSString>> = unsafe {
        main_bundle.pathForResource_ofType(Some(&resource_name), Some(&resource_type))
    };

    let path = path.ok_or("bundle.js not found in app bundle")?;
    let path_str = path.to_string();
    log::info!("ferrum-ios: loading JS from {path_str}");
    std::fs::read(&path_str).map_err(|e| format!("read {path_str}: {e}"))
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

fn init_logging() {
    // Route log! macros to the os_log subsystem visible in Console.app.
    // Filter level is set to Trace in debug builds; Info in release.
    #[cfg(debug_assertions)]
    let level = log::LevelFilter::Trace;
    #[cfg(not(debug_assertions))]
    let level = log::LevelFilter::Info;

    oslog::OsLogger::new("com.ferrum.app")
        .level_filter(level)
        .init()
        .ok(); // ok() because init() fails if already initialised (harmless)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Phase 1: add tests back once UIKit scene lifecycle is resolved
