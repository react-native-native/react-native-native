//! `FerumRuntime` — shared Hermes runtime initialization for Project Ferrum.
//!
//! This is the main entry point used by both `ferrum-ios` and `ferrum-android`.
//! It:
//!   1. Creates a Hermes runtime via `hermes-abi-rs`.
//!   2. Registers built-in Rust globals (`rust_add`).
//!   3. Provides a simple API for loading and running JS bundles.

use hermes_abi_rs::{
    error::Result,
    runtime::HermesRuntime,
    value::Value,
};

/// The Phase 0 Ferrum runtime: a thin orchestration layer over `HermesRuntime`.
///
/// Create one instance per process. It is `Send` (may be moved to a background
/// thread) but not `Sync` (do not share across threads without external locking).
pub struct FerumRuntime {
    hermes: HermesRuntime,
}

impl FerumRuntime {
    /// Create a new Ferrum runtime.
    ///
    /// Boots Hermes and registers all built-in Rust globals. Call this once at
    /// process start, before any JS is evaluated.
    ///
    /// # TODO(platform-linking)
    /// `HermesRuntime::new()` calls `get_hermes_abi_vtable()`, which requires
    /// the Hermes library to be linked. Platform crates must add the correct
    /// link directives in their `build.rs` before this will link.
    pub fn new() -> Result<Self> {
        let hermes = HermesRuntime::new()?;
        let rt = FerumRuntime { hermes };
        rt.register_builtins()?;
        Ok(rt)
    }

    // -----------------------------------------------------------------------
    // Built-in registrations
    // -----------------------------------------------------------------------

    fn register_builtins(&self) -> Result<()> {
        self.register_rust_add()?;
        Ok(())
    }

    /// Register `rust_add(a: number, b: number) -> number` as a JS global.
    ///
    /// This is the Phase 0 proof-of-concept: a synchronous Rust function
    /// callable from JS with no bridge overhead.
    ///
    /// ```js
    /// var result = rust_add(40, 2);
    /// print("result = " + result); // "result = 42"
    /// ```
    fn register_rust_add(&self) -> Result<()> {
        self.hermes.register_global_fn("rust_add", 2, |_rt, _this, args| {
            let a = args
                .first()
                .and_then(|v| v.as_number())
                .unwrap_or(0.0);
            let b = args
                .get(1)
                .and_then(|v| v.as_number())
                .unwrap_or(0.0);
            Ok(Value::Number(a + b))
        })
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    /// Register an additional Rust function as a named JS global.
    ///
    /// Platform crates can use this to expose platform-specific APIs (e.g.
    /// logging, I/O) before the JS bundle is evaluated.
    ///
    /// # Example
    /// ```no_run
    /// # use ferrum_core::bootstrap::FerumRuntime;
    /// # use hermes_abi_rs::value::Value;
    /// let rt = FerumRuntime::new().unwrap();
    /// rt.register_global_fn("log_native", 1, |_rt, _this, args| {
    ///     if let Some(s) = args.first() {
    ///         // platform logging here
    ///         let _ = s;
    ///     }
    ///     Ok(Value::Undefined)
    /// }).unwrap();
    /// ```
    pub fn register_global_fn<F>(&self, name: &str, length: u32, callback: F) -> Result<()>
    where
        F: Fn(&HermesRuntime, &Value, &[Value]) -> Result<Value> + Send + Sync + 'static,
    {
        self.hermes.register_global_fn(name, length, callback)
    }

    /// Evaluate a JS source bundle (UTF-8 bytes).
    ///
    /// Returns the completion value of the last expression, or a `HermesError`
    /// if JS throws.
    pub fn evaluate_bundle(&self, source: &[u8], url: &str) -> Result<Value> {
        log::debug!("ferrum-core: evaluating bundle '{}' ({} bytes)", url, source.len());
        let result = self.hermes.evaluate_js(source, url)?;
        log::debug!("ferrum-core: bundle evaluation complete");
        Ok(result)
    }

    /// Evaluate pre-compiled Hermes bytecode.
    pub fn evaluate_bytecode(&self, bytecode: &[u8], url: &str) -> Result<Value> {
        log::debug!("ferrum-core: evaluating bytecode '{}' ({} bytes)", url, bytecode.len());
        self.hermes.evaluate_bytecode(bytecode, url)
    }

    /// Access the underlying `HermesRuntime` for advanced use cases.
    pub fn hermes(&self) -> &HermesRuntime {
        &self.hermes
    }
}
