//! Error types for Hermes ABI failures.

use thiserror::Error;

/// Errors that can occur when interacting with the Hermes runtime via the C ABI.
#[derive(Debug, Error)]
pub enum HermesError {
    /// A JavaScript exception was thrown. The message has been extracted from
    /// the runtime via `get_and_clear_js_error_value`.
    #[error("JS exception: {0}")]
    JsException(String),

    /// A native (Rust/C++) exception was reported via `set_native_exception_message`.
    #[error("native exception: {0}")]
    NativeException(String),

    /// The runtime pointer returned from `make_hermes_runtime` was null.
    #[error("failed to create Hermes runtime (null pointer returned)")]
    RuntimeCreationFailed,

    /// A string operation failed (e.g. `create_string_from_utf8` returned an error).
    #[error("string operation failed")]
    StringOperationFailed,

    /// A property get/set operation failed.
    #[error("property operation failed: {0}")]
    PropertyOperationFailed(String),

    /// A function call from Rust → JS failed.
    #[error("JS function call failed")]
    CallFailed,

    /// An argument passed to a host function could not be interpreted as the
    /// expected type.
    #[error("argument type mismatch: expected {expected}, got {got}")]
    ArgumentTypeMismatch {
        expected: &'static str,
        got: &'static str,
    },
}

pub type Result<T> = std::result::Result<T, HermesError>;
