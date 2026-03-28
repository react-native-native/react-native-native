//! Rust bindings to the Hermes JS engine stable C ABI.
//!
//! This crate provides:
//! - [`ffi`]: Raw `extern "C"` declarations mirroring `hermes_abi.h` exactly.
//! - [`runtime`]: Safe `HermesRuntime` wrapper.
//! - [`value`]: Safe `Value`, `Object`, `Function`, `JsString` RAII wrappers.
//! - [`error`]: `HermesError` and `Result` types.
//!
//! # Linking
//! This crate declares `extern "C" { fn get_hermes_abi_vtable(); }` but does
//! not configure the linker. Platform crates (`ferrum-ios`, `ferrum-android`)
//! must add `build.rs` link directives pointing at the correct Hermes library
//! artifact for their target.
//!
//! # Example
//! ```no_run
//! use hermes_abi_rs::runtime::HermesRuntime;
//! use hermes_abi_rs::value::Value;
//!
//! let rt = HermesRuntime::new().expect("failed to create Hermes runtime");
//!
//! rt.register_global_fn("rust_add", 2, |_rt, _this, args| {
//!     let a = args.get(0).and_then(|v| v.as_number()).unwrap_or(0.0);
//!     let b = args.get(1).and_then(|v| v.as_number()).unwrap_or(0.0);
//!     Ok(Value::Number(a + b))
//! }).expect("register_global_fn failed");
//!
//! let result = rt
//!     .evaluate_js(b"rust_add(40, 2);", "test.js")
//!     .expect("evaluate failed");
//!
//! assert_eq!(result.as_number(), Some(42.0));
//! ```

pub mod error;
pub mod ffi;
pub mod runtime;
pub mod value;
