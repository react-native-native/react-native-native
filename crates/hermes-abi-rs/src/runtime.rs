//! Safe Rust wrapper around a Hermes runtime instance.
//!
//! `HermesRuntime` is the primary entry point for embedding Hermes. It wraps
//! `*mut HermesABIRuntime` and ensures the runtime is released on drop.
//!
//! # Usage
//! ```no_run
//! use hermes_abi_rs::runtime::HermesRuntime;
//! use hermes_abi_rs::value::Value;
//!
//! let rt = HermesRuntime::new().expect("failed to create Hermes runtime");
//!
//! // Register a Rust function as a JS global
//! rt.register_global_fn("rust_add", 2, |_rt, _this, args| {
//!     let a = args.first().and_then(|v| v.as_number()).unwrap_or(0.0);
//!     let b = args.get(1).and_then(|v| v.as_number()).unwrap_or(0.0);
//!     Ok(Value::Number(a + b))
//! }).expect("register_global_fn failed");
//!
//! let result = rt.evaluate_js(b"rust_add(1, 2);", "test.js")
//!     .expect("evaluate failed");
//! ```

use std::ffi::CString;

use crate::{
    error::{HermesError, Result},
    ffi::{
        HermesABIBuffer, HermesABIBufferVTable, HermesABIGrowableBuffer,
        HermesABIGrowableBufferVTable, HermesABIHostFunction, HermesABIHostFunctionVTable,
        HermesABIRuntime, HermesABIValue, HermesABIValueOrError,
    },
    value::{release_pointer, Value},
};

// ---------------------------------------------------------------------------
// HostFunction type alias
// ---------------------------------------------------------------------------

/// A Rust callback that can be called from JavaScript.
///
/// Arguments:
/// - `rt`: shared reference to the calling runtime (for creating return values)
/// - `this`: the `this` argument
/// - `args`: positional arguments
///
/// Returns a `Value` to hand back to JS, or a `HermesError` which will be
/// re-thrown as a JS exception.
pub type HostFn = dyn Fn(&HermesRuntime, &Value, &[Value]) -> Result<Value> + Send + Sync;

// ---------------------------------------------------------------------------
// GrowableBuffer — Rust implementation of HermesABIGrowableBuffer
// ---------------------------------------------------------------------------

/// A `Vec<u8>` wrapped to satisfy `HermesABIGrowableBuffer`.
struct GrowableBuffer {
    abi: HermesABIGrowableBuffer,
    _vec: Vec<u8>,
}

unsafe extern "C" fn growable_try_grow_to(buf: *mut HermesABIGrowableBuffer, sz: libc::size_t) {
    // SAFETY: `buf` is always a pointer into a `GrowableBuffer.abi` field, and
    // this callback is only invoked while the owning `GrowableBuffer` is live.
    unsafe {
        let gb = &mut *(buf as *mut GrowableBuffer);
        if gb._vec.len() < sz {
            gb._vec.resize(sz, 0);
            gb.abi.data = gb._vec.as_mut_ptr();
            gb.abi.size = sz;
        }
    }
}

static GROWABLE_VTABLE: HermesABIGrowableBufferVTable = HermesABIGrowableBufferVTable {
    try_grow_to: growable_try_grow_to,
};

impl GrowableBuffer {
    fn new() -> Box<Self> {
        let mut gb = Box::new(GrowableBuffer {
            abi: HermesABIGrowableBuffer {
                vtable: &GROWABLE_VTABLE,
                data: std::ptr::null_mut(),
                size: 0,
                used: 0,
            },
            _vec: Vec::new(),
        });
        // Point abi.data at the vec's buffer (empty for now)
        gb.abi.data = gb._vec.as_mut_ptr();
        gb
    }

    fn as_str(&self) -> &[u8] {
        &self._vec[..self.abi.used]
    }
}

// ---------------------------------------------------------------------------
// SliceBuffer — wraps a &[u8] as HermesABIBuffer for evaluate calls
// ---------------------------------------------------------------------------

/// An owning buffer that copies source bytes and appends a NUL terminator.
/// The Hermes C ABI requires: "The buffer must have a past-the-end null
/// terminator" for `evaluate_javascript_source`.
struct OwnedBuffer {
    abi: HermesABIBuffer,
    _data: Vec<u8>,
}

unsafe extern "C" fn owned_buffer_release(_self: *mut HermesABIBuffer) {
    // No-op: the Vec is dropped when OwnedBuffer is dropped.
}

static OWNED_BUFFER_VTABLE: HermesABIBufferVTable = HermesABIBufferVTable {
    release: owned_buffer_release,
};

impl OwnedBuffer {
    fn new(data: &[u8]) -> Self {
        // Copy data and append NUL terminator as required by Hermes ABI.
        let mut vec = Vec::with_capacity(data.len() + 1);
        vec.extend_from_slice(data);
        vec.push(0); // past-the-end null terminator
        let mut buf = OwnedBuffer {
            abi: HermesABIBuffer {
                vtable: &OWNED_BUFFER_VTABLE,
                data: std::ptr::null(), // set below
                size: data.len(),       // size excludes the NUL
            },
            _data: vec,
        };
        buf.abi.data = buf._data.as_ptr();
        buf
    }
}

// ---------------------------------------------------------------------------
// HostFunctionState — heap-allocated closure handed to Hermes
// ---------------------------------------------------------------------------

/// The heap-allocated state behind a registered host function. Hermes holds
/// a raw `*mut HermesABIHostFunction` pointer; this struct starts with that
/// field so the pointer can be safely cast.
/// `abi` and `rt_ptr` are accessed via raw pointer casts, not by name.
#[allow(dead_code)]
#[repr(C)]
struct HostFunctionState {
    abi: HermesABIHostFunction,
    // Non-null pointer to the runtime that owns this function. Used to
    // construct the safe `&HermesRuntime` passed to the callback.
    rt_ptr: *mut HermesABIRuntime,
    callback: Box<HostFn>,
}

unsafe extern "C" fn host_fn_release(self_: *mut HermesABIHostFunction) {
    // SAFETY: `self_` was created as `Box<HostFunctionState>` and leaked; we
    // reclaim it here when Hermes signals that the JS Function object has been
    // GC'd.
    unsafe {
        let _ = Box::from_raw(self_ as *mut HostFunctionState);
    }
}

unsafe extern "C" fn host_fn_call(
    self_: *mut HermesABIHostFunction,
    rt: *mut HermesABIRuntime,
    this_arg: *const HermesABIValue,
    args: *const HermesABIValue,
    arg_count: libc::size_t,
) -> HermesABIValueOrError {
    // SAFETY:
    // - `self_` was created from `Box<HostFunctionState>` and is valid for
    //   the duration of this call (Hermes guarantees the JS Function object,
    //   and hence this state, is live during a call).
    // - `rt` is the same runtime that created this function; its vtable is
    //   valid.
    // - `this_arg` and `args` point to an array of `arg_count` valid values
    //   owned by Hermes for the duration of this call.
    unsafe {
        let state = &*(self_ as *const HostFunctionState);

        // Wrap `rt` in a temporary `HermesRuntime` view. We do NOT drop it
        // (the runtime is not ours to destroy).
        let rt_wrapper = HermesRuntime { ptr: rt };

        // Decode the `this` argument without taking ownership (we borrow it).
        let this_raw = *this_arg;
        let this_val = Value::from_raw(this_raw);

        // Decode positional arguments the same way.
        let args_slice = std::slice::from_raw_parts(args, arg_count);
        let mut arg_values: Vec<Value> = Vec::with_capacity(arg_count);
        for &raw in args_slice {
            arg_values.push(Value::from_raw(raw));
        }

        let result = (state.callback)(&rt_wrapper, &this_val, &arg_values);

        // Prevent `rt_wrapper` destructor from releasing the runtime.
        std::mem::forget(rt_wrapper);
        // Prevent value destructors from releasing Hermes-owned references
        // (they were borrowed, not taken).
        std::mem::forget(this_val);
        for v in arg_values {
            std::mem::forget(v);
        }

        match result {
            Ok(val) => {
                let raw = val.as_raw();
                // Hermes now owns the returned value; prevent our RAII wrapper
                // from releasing it.
                std::mem::forget(val);
                HermesABIValueOrError { value: raw }
            }
            Err(e) => {
                // Report the error back through the runtime and return an
                // error-kinded value.
                let msg = e.to_string();
                let msg_bytes = msg.as_bytes();
                ((*(*rt).vt).set_native_exception_message)(
                    rt,
                    msg_bytes.as_ptr(),
                    msg_bytes.len(),
                );
                HermesABIValueOrError {
                    value: HermesABIValue {
                        kind: crate::ffi::HermesABIValueKind::Error,
                        data: crate::ffi::HermesABIValueData {
                            error: crate::ffi::HermesABIErrorCode::NativeException,
                        },
                    },
                }
            }
        }
    }
}

static HOST_FUNCTION_VTABLE: HermesABIHostFunctionVTable = HermesABIHostFunctionVTable {
    release: host_fn_release,
    call: host_fn_call,
};

// ---------------------------------------------------------------------------
// HermesRuntime — the public safe wrapper
// ---------------------------------------------------------------------------

/// A live Hermes runtime instance.
///
/// Owns the `*mut HermesABIRuntime` and releases it on drop.
pub struct HermesRuntime {
    ptr: *mut HermesABIRuntime,
}

// SAFETY: Hermes runtimes are not thread-safe internally, but we model
// HermesRuntime as Send (not Sync) — it may be moved across threads but
// must not be shared concurrently. Callers are responsible for ensuring
// single-threaded access per runtime.
unsafe impl Send for HermesRuntime {}

impl Drop for HermesRuntime {
    fn drop(&mut self) {
        // SAFETY: `ptr` is a valid runtime pointer obtained from Hermes.
        // `release` is called exactly once (here, on drop).
        unsafe {
            ((*(*self.ptr).vt).release)(self.ptr);
        }
    }
}

impl HermesRuntime {
    /// Create a new Hermes runtime with default configuration.
    ///
    /// Calls `get_hermes_abi_vtable()` from the linked Hermes library and
    /// invokes `make_hermes_runtime(NULL)`.
    ///
    /// # TODO(platform-linking)
    /// The Hermes library must be linked before this can be called. See the
    /// `build.rs` TODO in `hermes-abi-rs/Cargo.toml`.
    pub fn new() -> Result<Self> {
        // SAFETY: `get_hermes_abi_vtable` is a well-known Hermes export.
        // Passing `NULL` for the config uses Hermes defaults, which is
        // correct for Phase 0.
        unsafe {
            let vtable = crate::ffi::get_hermes_abi_vtable();
            if vtable.is_null() {
                return Err(HermesError::RuntimeCreationFailed);
            }
            let rt = ((*vtable).make_hermes_runtime)(std::ptr::null());
            if rt.is_null() {
                return Err(HermesError::RuntimeCreationFailed);
            }
            Ok(HermesRuntime { ptr: rt })
        }
    }

    // -----------------------------------------------------------------------
    // Error extraction helpers
    // -----------------------------------------------------------------------

    /// Extract and clear the pending JS or native exception from the runtime,
    /// returning it as a `HermesError`.
    ///
    /// Must be called exactly once after a failed ABI operation.
    fn extract_error(&self, error_code: crate::ffi::HermesABIErrorCode) -> HermesError {
        use crate::ffi::HermesABIErrorCode;
        match error_code {
            HermesABIErrorCode::JSError => {
                // SAFETY: `ptr` is valid; we are calling this exactly once
                // in response to an error return.
                let raw_val =
                    unsafe { ((*(*self.ptr).vt).get_and_clear_js_error_value)(self.ptr) };
                // Try to read the error as a string value for the message.
                let msg = unsafe {
                    if raw_val.kind == crate::ffi::HermesABIValueKind::String {
                        let s = crate::ffi::HermesABIString {
                            pointer: raw_val.data.pointer,
                        };
                        let msg = self.string_to_rust(&s);
                        release_pointer(s.pointer);
                        msg.unwrap_or_else(|_| "<unreadable JS error>".into())
                    } else {
                        // Release the value (it might be an object) and return
                        // a generic message.
                        if raw_val.kind as u32 & (1u32 << 31) != 0 {
                            release_pointer(raw_val.data.pointer);
                        }
                        "<non-string JS error>".into()
                    }
                };
                HermesError::JsException(msg)
            }
            HermesABIErrorCode::NativeException => {
                let mut buf = GrowableBuffer::new();
                // SAFETY: same as above.
                unsafe {
                    ((*(*self.ptr).vt).get_and_clear_native_exception_message)(
                        self.ptr,
                        &mut buf.abi,
                    );
                }
                let msg =
                    String::from_utf8_lossy(buf.as_str()).into_owned();
                HermesError::NativeException(msg)
            }
        }
    }

    // -----------------------------------------------------------------------
    // Utility: HermesABIString → Rust String
    // -----------------------------------------------------------------------

    /// Read a `HermesABIString` into a Rust `String` without releasing the
    /// managed pointer.
    ///
    /// # Safety
    /// `s.pointer` must be valid and non-null.
    unsafe fn string_to_rust(&self, s: &crate::ffi::HermesABIString) -> Result<String> {
        let mut buf = GrowableBuffer::new();
        // SAFETY: `s` and `self.ptr` are valid; `buf` lives for the call.
        unsafe {
            ((*(*self.ptr).vt).get_utf8_from_string)(self.ptr, *s, &mut buf.abi);
        }
        Ok(String::from_utf8_lossy(buf.as_str()).into_owned())
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    /// Evaluate a JavaScript source string.
    ///
    /// The `source_url` is used in stack traces; pass `"<eval>"` if unknown.
    ///
    /// ```no_run
    /// # use hermes_abi_rs::runtime::HermesRuntime;
    /// let rt = HermesRuntime::new().unwrap();
    /// let val = rt.evaluate_js(b"1 + 1", "<eval>").unwrap();
    /// assert!(val.as_number() == Some(2.0));
    /// ```
    pub fn evaluate_js(&self, source: &[u8], source_url: &str) -> Result<Value> {
        let url = CString::new(source_url).expect("source_url must not contain NUL");
        let mut buf = OwnedBuffer::new(source);

        // SAFETY: `ptr` is a valid runtime; `buf.abi` lives for the call
        // duration; `url` has no embedded NUL.
        let result = unsafe {
            ((*(*self.ptr).vt).evaluate_javascript_source)(
                self.ptr,
                &mut buf.abi,
                url.as_ptr(),
                url.to_bytes().len(),
            )
        };

        if result.is_error() {
            // SAFETY: result.is_error() was true; error_code() is valid.
            let code = unsafe { result.error_code() };
            return Err(self.extract_error(code));
        }

        // SAFETY: result is not an error and value is valid.
        Ok(unsafe { Value::from_raw(result.value) })
    }

    /// Evaluate pre-compiled Hermes bytecode.
    ///
    /// The caller is responsible for ensuring the bytecode was compiled for a
    /// compatible Hermes version. No validation is performed by the ABI.
    pub fn evaluate_bytecode(&self, bytecode: &[u8], source_url: &str) -> Result<Value> {
        let url = CString::new(source_url).expect("source_url must not contain NUL");
        let mut buf = OwnedBuffer::new(bytecode);

        // SAFETY: same as evaluate_js above.
        let result = unsafe {
            ((*(*self.ptr).vt).evaluate_hermes_bytecode)(
                self.ptr,
                &mut buf.abi,
                url.as_ptr(),
                url.to_bytes().len(),
            )
        };

        if result.is_error() {
            let code = unsafe { result.error_code() };
            return Err(self.extract_error(code));
        }

        Ok(unsafe { Value::from_raw(result.value) })
    }

    /// Get the JS global object.
    pub fn global(&self) -> Value {
        // SAFETY: `get_global_object` never fails.
        let obj = unsafe { ((*(*self.ptr).vt).get_global_object)(self.ptr) };
        Value::Object(crate::value::Object { inner: obj })
    }

    /// Register a Rust closure as a named property on the JS global object.
    ///
    /// This is the primary mechanism for exposing Rust functionality to JS in
    /// Phase 0. The function will appear as `globalThis.<name>` in JS.
    ///
    /// ```no_run
    /// # use hermes_abi_rs::{runtime::HermesRuntime, value::Value};
    /// let rt = HermesRuntime::new().unwrap();
    /// rt.register_global_fn("rust_add", 2, |_rt, _this, args| {
    ///     let a = args[0].as_number().unwrap_or(0.0);
    ///     let b = args[1].as_number().unwrap_or(0.0);
    ///     Ok(Value::Number(a + b))
    /// }).unwrap();
    /// ```
    pub fn register_global_fn<F>(&self, name: &str, length: u32, callback: F) -> Result<()>
    where
        F: Fn(&HermesRuntime, &Value, &[Value]) -> Result<Value> + Send + Sync + 'static,
    {
        // 1. Create the PropNameID for the function name.
        let name_bytes = name.as_bytes();
        let name_str_or_err = unsafe {
            ((*(*self.ptr).vt).create_string_from_utf8)(
                self.ptr,
                name_bytes.as_ptr(),
                name_bytes.len(),
            )
        };
        if name_str_or_err.is_error() {
            return Err(HermesError::StringOperationFailed);
        }
        let name_str = name_str_or_err.unwrap_pointer();

        let name_id_or_err = unsafe {
            ((*(*self.ptr).vt).create_propnameid_from_string)(
                self.ptr,
                crate::ffi::HermesABIString { pointer: name_str.pointer },
            )
        };
        // Release the string — PropNameID has its own reference.
        unsafe { release_pointer(name_str.pointer) };

        if name_id_or_err.is_error() {
            return Err(HermesError::StringOperationFailed);
        }
        let name_id = name_id_or_err.unwrap_pointer();
        let name_id_typed = crate::ffi::HermesABIPropNameID {
            pointer: name_id.pointer,
        };

        // 2. Allocate the HostFunctionState on the heap and leak it.
        // Hermes takes ownership and will call `host_fn_release` when the JS
        // Function object is GC'd.
        let state = Box::new(HostFunctionState {
            abi: HermesABIHostFunction {
                vtable: &HOST_FUNCTION_VTABLE,
            },
            rt_ptr: self.ptr,
            callback: Box::new(callback),
        });
        let state_ptr = Box::into_raw(state);

        // 3. Register the host function with the runtime.
        let fn_or_err = unsafe {
            ((*(*self.ptr).vt).create_function_from_host_function)(
                self.ptr,
                name_id_typed,
                length,
                state_ptr as *mut HermesABIHostFunction,
            )
        };
        // Release the PropNameID — the function has its own reference.
        unsafe { release_pointer(name_id.pointer) };

        if fn_or_err.is_error() {
            // Reclaim the leaked state to avoid a leak.
            // SAFETY: state_ptr was just created above and not yet given to Hermes.
            unsafe { let _ = Box::from_raw(state_ptr); }
            return Err(HermesError::PropertyOperationFailed(
                "create_function_from_host_function failed".into(),
            ));
        }

        // 4. Set `global[name] = fn`.
        let fn_ptr = fn_or_err.unwrap_pointer();
        let fn_as_value = HermesABIValue {
            kind: crate::ffi::HermesABIValueKind::Object,
            data: crate::ffi::HermesABIValueData {
                pointer: fn_ptr.pointer,
            },
        };

        let global_obj = unsafe { ((*(*self.ptr).vt).get_global_object)(self.ptr) };

        // Create a PropNameID for the property key on global.
        let key_bytes = name.as_bytes();
        let key_str_or_err = unsafe {
            ((*(*self.ptr).vt).create_string_from_utf8)(
                self.ptr,
                key_bytes.as_ptr(),
                key_bytes.len(),
            )
        };
        if key_str_or_err.is_error() {
            unsafe { release_pointer(fn_ptr.pointer) };
            return Err(HermesError::StringOperationFailed);
        }
        let key_str = key_str_or_err.unwrap_pointer();
        let key_id_or_err = unsafe {
            ((*(*self.ptr).vt).create_propnameid_from_string)(
                self.ptr,
                crate::ffi::HermesABIString { pointer: key_str.pointer },
            )
        };
        unsafe { release_pointer(key_str.pointer) };

        if key_id_or_err.is_error() {
            unsafe { release_pointer(fn_ptr.pointer) };
            return Err(HermesError::StringOperationFailed);
        }
        let key_id = key_id_or_err.unwrap_pointer();

        let void_or_err = unsafe {
            ((*(*self.ptr).vt).set_object_property_from_propnameid)(
                self.ptr,
                global_obj,
                crate::ffi::HermesABIPropNameID { pointer: key_id.pointer },
                &fn_as_value,
            )
        };

        // Release temporaries.
        unsafe {
            release_pointer(fn_ptr.pointer);
            release_pointer(key_id.pointer);
            release_pointer(global_obj.pointer);
        }

        if void_or_err.is_error() {
            let code = void_or_err.error_code();
            return Err(self.extract_error(code));
        }

        Ok(())
    }

    /// Get the raw runtime pointer.
    ///
    /// For use only by platform crates that need to pass the runtime to other
    /// ABI functions not yet wrapped by this crate.
    pub fn as_raw_ptr(&self) -> *mut HermesABIRuntime {
        self.ptr
    }
}
