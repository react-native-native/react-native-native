//! Ferrum runtime bootstrap for iOS.
//!
//! Creates a real Hermes runtime via ferrum-core, registers `rust_add`,
//! and evaluates the JS bundle.

use ferrum_core::bootstrap::FerumRuntime;

/// Bootstraps the Ferrum runtime: creates a Hermes instance, registers
/// `rust_add` (built into FerumRuntime), and evaluates the JS bundle.
///
/// Returns the string representation of the evaluation result.
pub fn bootstrap_ferrum_runtime(bundle_bytes: &[u8]) -> Result<String, String> {
    log::info!("ferrum-ios: creating Hermes runtime via ferrum-core...");

    let rt = FerumRuntime::new().map_err(|e| format!("FerumRuntime::new failed: {e}"))?;

    log::info!("ferrum-ios: Hermes runtime created, rust_add registered. Testing global object access...");

    // Verify the global object is accessible (sanity check vtable).
    let global = rt.hermes().global();
    log::info!("ferrum-ios: global object retrieved successfully: is_object={}",
        global.as_number().is_none());
    // First try a trivial expression to verify evaluate_js works at all.
    log::info!("ferrum-ios: testing trivial JS evaluation: '1 + 1'...");
    match rt.hermes().evaluate_js(b"1 + 1;", "<test>") {
        Ok(val) => {
            let n = val.as_number().unwrap_or(f64::NAN);
            log::info!("ferrum-ios: trivial eval result: {n}");
        }
        Err(e) => {
            log::error!("ferrum-ios: trivial eval FAILED: {e}");
            return Err(format!("trivial eval failed: {e}"));
        }
    }

    // Test rust_add call from JS
    log::info!("ferrum-ios: testing rust_add(40, 2) from JS...");
    match rt.hermes().evaluate_js(b"rust_add(40, 2);", "<test-rust-add>") {
        Ok(val) => {
            let n = val.as_number().unwrap_or(f64::NAN);
            log::info!("ferrum-ios: rust_add(40, 2) = {n}");
        }
        Err(e) => {
            log::error!("ferrum-ios: rust_add eval FAILED: {e}");
            return Err(format!("rust_add eval failed: {e}"));
        }
    }

    // Test string concatenation (triggers internal Hermes string ops)
    log::info!("ferrum-ios: testing string concat...");
    match rt.hermes().evaluate_js(b"'hello' + ' world';", "<test-string>") {
        Ok(_val) => log::info!("ferrum-ios: string concat OK"),
        Err(e) => log::error!("ferrum-ios: string concat FAILED: {e}"),
    }

    log::info!(
        "ferrum-ios: evaluating JS bundle ({} bytes)...",
        bundle_bytes.len()
    );

    let result = rt
        .evaluate_bundle(bundle_bytes, "bundle.js")
        .map_err(|e| format!("evaluate_bundle failed: {e}"))?;

    // Value doesn't implement Debug — extract the number if present.
    let result_str = if let Some(n) = result.as_number() {
        format!("{n}")
    } else {
        "non-numeric result".to_string()
    };
    log::info!("ferrum-ios: JS evaluation result: {result_str}");

    // Leak the runtime to avoid drop crash during Hermes shutdown.
    // Phase 0: the process exits after UIApplicationMain anyway.
    // Phase 1: runtime will be stored in AppDelegate ivar with proper lifecycle.
    std::mem::forget(rt);

    Ok(result_str)
}
