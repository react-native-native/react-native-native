//! Safe Rust wrappers for Hermes JS values.
//!
//! The Hermes ABI uses an owned-reference model for pointer-kinded values
//! (String, Object, Function, etc.): every such reference must be explicitly
//! released via `HermesABIManagedPointer::vtable::invalidate`. This module
//! provides RAII wrappers that call `invalidate` on drop.
//!
//! `Value` is the general-purpose enum. `JsString`, `Object`, and `Function`
//! are typed wrappers for the most common sub-kinds.

use crate::ffi::{
    HermesABIBigInt, HermesABIFunction, HermesABIManagedPointer, HermesABIObject,
    HermesABIString, HermesABISymbol, HermesABIValue, HermesABIValueKind,
};

// ---------------------------------------------------------------------------
// Helper: release a managed pointer
// ---------------------------------------------------------------------------

/// Release a managed pointer by calling its `invalidate` vtable slot.
///
/// # Safety
/// `ptr` must be a valid, non-null managed pointer whose vtable is populated
/// by the Hermes runtime.
pub(crate) unsafe fn release_pointer(ptr: *mut HermesABIManagedPointer) {
    // SAFETY: pointer comes from Hermes; vtable is always non-null and valid
    // for the lifetime of the runtime. Caller guarantees `ptr` is non-null.
    unsafe {
        let vt = (*ptr).vtable;
        ((*vt).invalidate)(ptr);
    }
}

// ---------------------------------------------------------------------------
// Typed wrappers
// ---------------------------------------------------------------------------

/// An owned reference to a JS string.
///
/// Releases the managed pointer on drop.
pub struct JsString {
    pub(crate) inner: HermesABIString,
}

impl Drop for JsString {
    fn drop(&mut self) {
        // SAFETY: `inner.pointer` was obtained from the Hermes runtime and has
        // not yet been invalidated.
        unsafe { release_pointer(self.inner.pointer) }
    }
}

/// An owned reference to a JS object (including arrays and functions).
///
/// Releases the managed pointer on drop.
pub struct Object {
    pub(crate) inner: HermesABIObject,
}

impl Drop for Object {
    fn drop(&mut self) {
        // SAFETY: same invariant as JsString above.
        unsafe { release_pointer(self.inner.pointer) }
    }
}

/// An owned reference to a callable JS function.
///
/// Releases the managed pointer on drop.
pub struct Function {
    pub(crate) inner: HermesABIFunction,
}

impl Drop for Function {
    fn drop(&mut self) {
        // SAFETY: same invariant as JsString above.
        unsafe { release_pointer(self.inner.pointer) }
    }
}

// ---------------------------------------------------------------------------
// General-purpose Value enum
// ---------------------------------------------------------------------------

/// A Rust representation of any JavaScript value that can cross the ABI.
///
/// Pointer-kinded variants own the underlying managed pointer and release it
/// on drop. Primitive variants (Undefined, Null, Boolean, Number) have no
/// heap allocation.
pub enum Value {
    Undefined,
    Null,
    Boolean(bool),
    Number(f64),
    String(JsString),
    Object(Object),
    Function(Function),
    // Symbol and BigInt are included for completeness but are uncommon in
    // Phase 0 use cases.
    Symbol(HermesABISymbol),
    BigInt(HermesABIBigInt),
}

impl Value {
    /// Construct a `Value` from the raw `HermesABIValue` returned by the ABI.
    ///
    /// Takes ownership of any managed pointer embedded in the raw value.
    ///
    /// # Safety
    /// `raw` must be a valid, non-error value whose managed pointer (if any)
    /// has not yet been released.
    pub(crate) unsafe fn from_raw(raw: HermesABIValue) -> Self {
        // SAFETY: caller guarantees raw is non-error and valid.
        unsafe {
            match raw.kind {
                HermesABIValueKind::Undefined => Value::Undefined,
                HermesABIValueKind::Null => Value::Null,
                HermesABIValueKind::Boolean => Value::Boolean(raw.data.boolean),
                HermesABIValueKind::Number => Value::Number(raw.data.number),
                HermesABIValueKind::String => Value::String(JsString {
                    inner: HermesABIString {
                        pointer: raw.data.pointer,
                    },
                }),
                HermesABIValueKind::Object => Value::Object(Object {
                    inner: HermesABIObject {
                        pointer: raw.data.pointer,
                    },
                }),
                HermesABIValueKind::Symbol => Value::Symbol(HermesABISymbol {
                    pointer: raw.data.pointer,
                }),
                HermesABIValueKind::BigInt => Value::BigInt(HermesABIBigInt {
                    pointer: raw.data.pointer,
                }),
                HermesABIValueKind::Error => {
                    // Should never be constructed as a Value — callers should
                    // check HermesABIValueOrError::is_error() first.
                    panic!("attempted to construct Value from an error kind");
                }
            }
        }
    }

    /// Returns the raw ABI value without transferring ownership.
    ///
    /// The returned `HermesABIValue` must NOT be released independently; the
    /// owning `Value` still manages the lifetime.
    pub(crate) fn as_raw(&self) -> HermesABIValue {
        match self {
            Value::Undefined => HermesABIValue {
                kind: HermesABIValueKind::Undefined,
                data: crate::ffi::HermesABIValueData { boolean: false },
            },
            Value::Null => HermesABIValue {
                kind: HermesABIValueKind::Null,
                data: crate::ffi::HermesABIValueData { boolean: false },
            },
            Value::Boolean(b) => HermesABIValue {
                kind: HermesABIValueKind::Boolean,
                data: crate::ffi::HermesABIValueData { boolean: *b },
            },
            Value::Number(n) => HermesABIValue {
                kind: HermesABIValueKind::Number,
                data: crate::ffi::HermesABIValueData { number: *n },
            },
            Value::String(s) => HermesABIValue {
                kind: HermesABIValueKind::String,
                data: crate::ffi::HermesABIValueData {
                    pointer: s.inner.pointer,
                },
            },
            Value::Object(o) => HermesABIValue {
                kind: HermesABIValueKind::Object,
                data: crate::ffi::HermesABIValueData {
                    pointer: o.inner.pointer,
                },
            },
            Value::Function(f) => HermesABIValue {
                kind: HermesABIValueKind::Object,
                data: crate::ffi::HermesABIValueData {
                    pointer: f.inner.pointer,
                },
            },
            Value::Symbol(s) => HermesABIValue {
                kind: HermesABIValueKind::Symbol,
                data: crate::ffi::HermesABIValueData { pointer: s.pointer },
            },
            Value::BigInt(b) => HermesABIValue {
                kind: HermesABIValueKind::BigInt,
                data: crate::ffi::HermesABIValueData { pointer: b.pointer },
            },
        }
    }

    pub fn is_undefined(&self) -> bool {
        matches!(self, Value::Undefined)
    }
    pub fn is_null(&self) -> bool {
        matches!(self, Value::Null)
    }
    pub fn is_number(&self) -> bool {
        matches!(self, Value::Number(_))
    }
    pub fn as_number(&self) -> Option<f64> {
        if let Value::Number(n) = self {
            Some(*n)
        } else {
            None
        }
    }
    pub fn as_bool(&self) -> Option<bool> {
        if let Value::Boolean(b) = self {
            Some(*b)
        } else {
            None
        }
    }
}
