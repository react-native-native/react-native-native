//! C FFI bridge for expo-ferrum integration.
//!
//! Exports `extern "C"` functions callable from Swift/Kotlin via the
//! Expo module's native code. These are thin wrappers around `FerumRuntime`.

use std::ffi::{CStr, CString};

use crate::bootstrap::FerumRuntime;

/// Initialize the Ferrum bridge inside an Expo app.
///
/// Phase 0 in Expo: proves the Rust FFI works alongside the standard RN stack.
/// Does NOT create a separate Hermes instance (the Expo app already has one).
/// Phase 1 will hook into the existing Hermes runtime via HermesABIRuntimeWrapper.
///
/// Returns a NUL-terminated C string. Caller must free with `ferrum_bridge_free_string`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ferrum_bridge_init() -> *mut std::ffi::c_char {
    #[cfg(target_os = "ios")]
    {
        let _ = oslog::OsLogger::new("com.ferrum.bridge")
            .level_filter(log::LevelFilter::Trace)
            .init();
    }

    log::info!("ferrum_bridge_init: Rust FFI bridge active inside Expo");

    // Prove Rust code runs: call rust_add directly (no Hermes needed).
    let a = 40.0_f64;
    let b = 2.0_f64;
    let result = a + b;
    log::info!("ferrum_bridge_init: rust_add({a}, {b}) = {result}");

    // Benchmark pure Rust function call overhead (baseline without Hermes)
    let iterations = 1_000_000u64;
    let start = std::time::Instant::now();
    let mut sum = 0.0_f64;
    for i in 0..iterations {
        sum += (i as f64) + (i as f64);
    }
    let elapsed = start.elapsed();
    let ns_per_call = elapsed.as_nanos() as f64 / iterations as f64;
    // Use sum to prevent optimization
    log::info!("ferrum_bridge_init: {iterations} calls in {:?}, {ns_per_call:.1}ns/call (sum={sum})", elapsed);

    let msg = format!("Ferrum active! rust_add(40,2)={result}, {ns_per_call:.1}ns/call pure Rust");

    CString::new(msg)
        .unwrap_or_else(|_| CString::new("ERROR").unwrap())
        .into_raw()
}

/// Free a string returned by `ferrum_bridge_init`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ferrum_bridge_free_string(ptr: *mut std::ffi::c_char) {
    if !ptr.is_null() {
        unsafe { let _ = CString::from_raw(ptr); }
    }
}
