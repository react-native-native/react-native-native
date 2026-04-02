//! Props — safe wrapper for JSI property access from Rust components.
//!
//! The `Props` type wraps raw JSI runtime + object pointers and provides
//! typed getters. The `#[component]` proc macro generates code that calls
//! these to populate struct fields from JS props.

use std::ffi::{c_void, CString};
use crate::ffi;

/// A reference to JS props passed to a component's `mount()` method.
/// Valid only during the `mount` call.
pub struct Props {
    runtime: *mut c_void,
    object: *mut c_void,
}

impl Props {
    /// Create from raw JSI pointers. Called by generated render code.
    pub fn new(runtime: *mut c_void, object: *mut c_void) -> Option<Self> {
        if runtime.is_null() || object.is_null() {
            None
        } else {
            Some(Self { runtime, object })
        }
    }

    /// Get a string property, or empty string if missing.
    pub fn get_string(&self, name: &str) -> String {
        let cname = CString::new(name).unwrap();
        let ptr = unsafe {
            ffi::nativ_jsi_get_string(self.runtime, self.object, cname.as_ptr())
        };
        if ptr.is_null() {
            String::new()
        } else {
            unsafe { std::ffi::CStr::from_ptr(ptr) }
                .to_str()
                .unwrap_or("")
                .to_string()
        }
    }

    /// Get a number property, or 0.0 if missing.
    pub fn get_number(&self, name: &str) -> f64 {
        let cname = CString::new(name).unwrap();
        unsafe { ffi::nativ_jsi_get_number(self.runtime, self.object, cname.as_ptr()) }
    }

    /// Get a boolean property, or false if missing.
    pub fn get_bool(&self, name: &str) -> bool {
        let cname = CString::new(name).unwrap();
        unsafe { ffi::nativ_jsi_get_bool(self.runtime, self.object, cname.as_ptr()) != 0 }
    }

    /// Check if a property exists.
    pub fn has(&self, name: &str) -> bool {
        let cname = CString::new(name).unwrap();
        unsafe { ffi::nativ_jsi_has_prop(self.runtime, self.object, cname.as_ptr()) != 0 }
    }

    /// Get a `Callback` for a function property (e.g., onPress).
    pub fn get_callback(&self, name: &str) -> Callback {
        Callback {
            runtime: self.runtime,
            object: self.object,
            prop_name: name.to_string(),
        }
    }
}

/// A JS callback function that can be invoked from Rust.
/// Holds a reference to the props object + property name.
/// Valid only during the `mount` call (same as Props).
pub struct Callback {
    runtime: *mut c_void,
    object: *mut c_void,
    prop_name: String,
}

impl Callback {
    /// A no-op callback (used as default when prop is missing).
    pub fn noop() -> Self {
        Self {
            runtime: std::ptr::null_mut(),
            object: std::ptr::null_mut(),
            prop_name: String::new(),
        }
    }

    /// Returns true if this is a real callback (not noop).
    pub fn is_set(&self) -> bool {
        !self.runtime.is_null() && !self.prop_name.is_empty()
    }

    /// Call the callback with no arguments.
    pub fn invoke(&self) {
        if !self.is_set() { return; }
        let cname = CString::new(self.prop_name.as_str()).unwrap();
        unsafe {
            ffi::nativ_jsi_call_function(self.runtime, self.object, cname.as_ptr());
        }
    }

    /// Call the callback with a string argument.
    pub fn invoke_with_string(&self, arg: &str) {
        if !self.is_set() { return; }
        let cname = CString::new(self.prop_name.as_str()).unwrap();
        let carg = CString::new(arg).unwrap();
        unsafe {
            ffi::nativ_jsi_call_function_with_string(
                self.runtime, self.object, cname.as_ptr(), carg.as_ptr()
            );
        }
    }
}
