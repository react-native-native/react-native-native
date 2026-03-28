//! C FFI bridge for the Ferrum orchestrator.
//!
//! `ferrum_register_globals` is called from FerrumRuntimeFactory (C++) BEFORE
//! the runtime is wrapped in JSI. Functions registered here bypass JSI entirely
//! — they're plain C function pointers in the Hermes C ABI vtable.

use crate::bootstrap::FerumRuntime;

/// Called from C++ (FerrumRuntimeFactory::createJSRuntime) to register
/// Rust-backed JS globals on the raw C ABI runtime.
///
/// This is the 0.20μs path: Hermes calls our extern "C" function pointer
/// directly, no JSI dispatch.
///
/// # Safety
/// `rt` and `vt` are valid pointers provided by FerrumRuntimeFactory
/// immediately after make_hermes_runtime().
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ferrum_register_globals(
    rt: *mut hermes_abi_rs::ffi::HermesABIRuntime,
    vt: *const hermes_abi_rs::ffi::HermesABIRuntimeVTable,
) {
    #[cfg(target_os = "ios")]
    {
        let _ = oslog::OsLogger::new("com.ferrum.bridge")
            .level_filter(log::LevelFilter::Trace)
            .init();
    }

    log::info!("ferrum_register_globals: registering Rust functions on C ABI runtime");

    // Wrap the raw pointers in our safe HermesRuntime (without taking ownership
    // of the runtime — FerrumRuntimeFactory owns it).
    // We use the runtime's register_global_fn which calls through the vtable.
    let hermes = unsafe { hermes_abi_rs::runtime::HermesRuntime::from_raw(rt) };

    // Register rust_add
    let result = hermes.register_global_fn("rust_add", 2, |_rt, _this, args| {
        let a = args.first().and_then(|v| v.as_number()).unwrap_or(0.0);
        let b = args.get(1).and_then(|v| v.as_number()).unwrap_or(0.0);
        Ok(hermes_abi_rs::value::Value::Number(a + b))
    });

    match result {
        Ok(()) => log::info!("ferrum_register_globals: rust_add registered"),
        Err(e) => log::error!("ferrum_register_globals: failed to register rust_add: {e}"),
    }

    // Don't drop — FerrumRuntimeFactory owns the runtime
    std::mem::forget(hermes);

    log::info!("ferrum_register_globals: done");
}
