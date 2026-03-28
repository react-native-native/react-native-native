//! Raw FFI bindings to the Hermes stable C ABI (`hermes_abi.h`).
//!
//! These types mirror the C structs and enums in `API/hermes_abi/hermes_abi.h`
//! exactly. The vtable pattern is preserved: both `HermesABIRuntime` and the
//! top-level `HermesABIVTable` hold `const *` pointers to vtables of function
//! pointers.
//!
//! The entry point exported by the Hermes library is:
//!   `const HermesABIVTable *get_hermes_abi_vtable(void);`
//!
//! Do NOT use these types directly in application code — use the safe wrappers
//! in [`crate::runtime`], [`crate::value`], and [`crate::error`] instead.

#![allow(non_camel_case_types, non_snake_case, dead_code)]

use libc::{c_char, c_int, c_uint, size_t, uintptr_t};

// ---------------------------------------------------------------------------
// Opaque types (forward-declared in the header, never dereferenced from Rust)
// ---------------------------------------------------------------------------

/// Runtime configuration. Created on the Hermes side; opaque to callers.
#[repr(C)]
pub struct HermesABIRuntimeConfig {
    _opaque: [u8; 0],
}

// ---------------------------------------------------------------------------
// ManagedPointer — base for all GC-tracked JS references
// ---------------------------------------------------------------------------

/// Vtable for a managed JS reference. The only operation is `invalidate`
/// (i.e. decrement the reference count / unroot the value).
#[repr(C)]
pub struct HermesABIManagedPointerVTable {
    pub invalidate: unsafe extern "C" fn(self_: *mut HermesABIManagedPointer),
}

/// A GC-tracked JS reference. All pointer-kinded JS values embed this as their
/// first (and only) field.
#[repr(C)]
pub struct HermesABIManagedPointer {
    pub vtable: *const HermesABIManagedPointerVTable,
}

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HermesABIErrorCode {
    NativeException = 0,
    JSError = 1,
}

// ---------------------------------------------------------------------------
// Typed pointer wrappers for each JS reference type
//
// The macro below generates, for each name N:
//   struct HermesABIN           { pointer: *mut HermesABIManagedPointer }
//   struct HermesABINOrError    { ptr_or_error: uintptr_t }
//
// Encoding: low bit of ptr_or_error == 1  ⟹ error; bits [∞:2] = ErrorCode.
// ---------------------------------------------------------------------------

macro_rules! declare_pointer_type {
    ($name:ident) => {
        paste::paste! {
            #[repr(C)]
            #[derive(Clone, Copy)]
            pub struct [<HermesABI $name>] {
                pub pointer: *mut HermesABIManagedPointer,
            }

            #[repr(C)]
            #[derive(Clone, Copy)]
            pub struct [<HermesABI $name OrError>] {
                pub ptr_or_error: uintptr_t,
            }

            impl [<HermesABI $name OrError>] {
                #[inline]
                pub fn is_error(self) -> bool {
                    self.ptr_or_error & 1 != 0
                }

                #[inline]
                pub fn error_code(self) -> HermesABIErrorCode {
                    // SAFETY: bit 0 is set (checked by caller), bits [∞:2] hold code
                    match self.ptr_or_error >> 2 {
                        0 => HermesABIErrorCode::NativeException,
                        _ => HermesABIErrorCode::JSError,
                    }
                }

                #[inline]
                pub fn unwrap_pointer(self) -> [<HermesABI $name>] {
                    [<HermesABI $name>] {
                        pointer: self.ptr_or_error as *mut HermesABIManagedPointer,
                    }
                }
            }
        }
    };
}

// Must add `paste` to Cargo.toml — it is used only for the macro expansion.
// All types produced match the HERMES_ABI_POINTER_TYPES(V) expansion in the C header.
declare_pointer_type!(Object);
declare_pointer_type!(Array);
declare_pointer_type!(String);
declare_pointer_type!(BigInt);
declare_pointer_type!(Symbol);
declare_pointer_type!(Function);
declare_pointer_type!(ArrayBuffer);
declare_pointer_type!(PropNameID);
declare_pointer_type!(WeakObject);

// ---------------------------------------------------------------------------
// Result types for void / bool / u8* / size_t returns
// ---------------------------------------------------------------------------

/// Returned by functions that may fail but have no useful success value.
/// Encoding: low bit == 1 ⟹ error; bits [∞:2] = ErrorCode.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct HermesABIVoidOrError {
    pub void_or_error: uintptr_t,
}

impl HermesABIVoidOrError {
    #[inline]
    pub fn is_error(self) -> bool {
        self.void_or_error & 1 != 0
    }
    #[inline]
    pub fn error_code(self) -> HermesABIErrorCode {
        match self.void_or_error >> 2 {
            0 => HermesABIErrorCode::NativeException,
            _ => HermesABIErrorCode::JSError,
        }
    }
}

/// Returned by boolean-valued functions that may also fail.
/// Encoding: low bit == 1 ⟹ error; bits [∞:2] = bool value or ErrorCode.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct HermesABIBoolOrError {
    pub bool_or_error: uintptr_t,
}

impl HermesABIBoolOrError {
    #[inline]
    pub fn is_error(self) -> bool {
        self.bool_or_error & 1 != 0
    }
    #[inline]
    pub fn error_code(self) -> HermesABIErrorCode {
        match self.bool_or_error >> 2 {
            0 => HermesABIErrorCode::NativeException,
            _ => HermesABIErrorCode::JSError,
        }
    }
    #[inline]
    pub fn bool_value(self) -> bool {
        // When not an error, value is in bits [∞:2]
        self.bool_or_error >> 2 != 0
    }
}

/// Returned by functions producing a raw byte pointer that may fail.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct HermesABIUint8PtrOrError {
    pub is_error: bool,
    pub data: HermesABIUint8PtrOrErrorData,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub union HermesABIUint8PtrOrErrorData {
    pub val: *mut u8,
    pub error: u16,
}

/// Returned by functions producing a `size_t` that may fail.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct HermesABISizeTOrError {
    pub is_error: bool,
    pub data: HermesABISizeTOrErrorData,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub union HermesABISizeTOrErrorData {
    pub val: size_t,
    pub error: u16,
}

/// Returned by `get_own_keys` on a HostObject.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct HermesABIPropNameIDListPtrOrError {
    pub ptr_or_error: uintptr_t,
}

// ---------------------------------------------------------------------------
// Value kind enum and HermesABIValue
// ---------------------------------------------------------------------------

/// Matches `HermesABIValueKind` in the header. The pointer-kinded variants all
/// have the top bit set (HERMES_ABI_POINTER_MASK).
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HermesABIValueKind {
    Undefined = 0,
    Null = 1,
    Boolean = 2,
    Error = 3,
    Number = 4,
    // pointer-kinded (top bit set on 32-bit; HERMES_ABI_POINTER_MASK)
    Symbol = 5 | (1u32 << 31) as isize,
    BigInt = 6 | (1u32 << 31) as isize,
    String = 7 | (1u32 << 31) as isize,
    Object = 9 | (1u32 << 31) as isize,
}

/// Matches `HermesABIValue`. Owns the managed-pointer reference for
/// pointer-kinded kinds; must be explicitly released.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct HermesABIValue {
    pub kind: HermesABIValueKind,
    pub data: HermesABIValueData,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub union HermesABIValueData {
    pub boolean: bool,
    pub number: f64,
    pub pointer: *mut HermesABIManagedPointer,
    pub error: HermesABIErrorCode,
}

/// Same memory layout as `HermesABIValue`; separate type for call-sites where
/// an error is possible.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct HermesABIValueOrError {
    pub value: HermesABIValue,
}

impl HermesABIValueOrError {
    #[inline]
    pub fn is_error(&self) -> bool {
        self.value.kind == HermesABIValueKind::Error
    }
    /// # Safety
    /// Call only when `is_error()` is true.
    #[inline]
    pub unsafe fn error_code(&self) -> HermesABIErrorCode {
        unsafe { self.value.data.error }
    }
}

// ---------------------------------------------------------------------------
// Growable / fixed buffers
// ---------------------------------------------------------------------------

#[repr(C)]
pub struct HermesABIGrowableBufferVTable {
    pub try_grow_to: unsafe extern "C" fn(buf: *mut HermesABIGrowableBuffer, sz: size_t),
}

/// Caller-provided resizable buffer for receiving variable-length data (UTF-8
/// strings, error messages, etc.) from the runtime without an extra copy.
#[repr(C)]
pub struct HermesABIGrowableBuffer {
    pub vtable: *const HermesABIGrowableBufferVTable,
    pub data: *mut u8,
    pub size: size_t,
    pub used: size_t,
}

#[repr(C)]
pub struct HermesABIBufferVTable {
    pub release: unsafe extern "C" fn(self_: *mut HermesABIBuffer),
}

/// An immutable byte buffer (JS source or bytecode). Hermes calls `release`
/// when it is done with the buffer.
#[repr(C)]
pub struct HermesABIBuffer {
    pub vtable: *const HermesABIBufferVTable,
    pub data: *const u8,
    pub size: size_t,
}

#[repr(C)]
pub struct HermesABIMutableBufferVTable {
    pub release: unsafe extern "C" fn(self_: *mut HermesABIMutableBuffer),
}

/// A mutable byte buffer for sharing data with JS (e.g. backing an
/// ArrayBuffer). Hermes calls `release` when done.
#[repr(C)]
pub struct HermesABIMutableBuffer {
    pub vtable: *const HermesABIMutableBufferVTable,
    pub data: *mut u8,
    pub size: size_t,
}

// ---------------------------------------------------------------------------
// HostFunction — Rust callbacks callable from JS
// ---------------------------------------------------------------------------

#[repr(C)]
pub struct HermesABIHostFunctionVTable {
    pub release: unsafe extern "C" fn(self_: *mut HermesABIHostFunction),
    pub call: unsafe extern "C" fn(
        self_: *mut HermesABIHostFunction,
        rt: *mut HermesABIRuntime,
        this_arg: *const HermesABIValue,
        args: *const HermesABIValue,
        arg_count: size_t,
    ) -> HermesABIValueOrError,
}

/// A Rust-implemented function exposed to JS. Hermes takes ownership and calls
/// `release` when the JS Function object is garbage-collected.
#[repr(C)]
pub struct HermesABIHostFunction {
    pub vtable: *const HermesABIHostFunctionVTable,
}

// ---------------------------------------------------------------------------
// PropNameIDList — returned by HostObject::get_own_keys
// ---------------------------------------------------------------------------

#[repr(C)]
pub struct HermesABIPropNameIDListVTable {
    pub release: unsafe extern "C" fn(self_: *mut HermesABIPropNameIDList),
}

#[repr(C)]
pub struct HermesABIPropNameIDList {
    pub vtable: *const HermesABIPropNameIDListVTable,
    pub props: *const HermesABIPropNameID,
    pub size: size_t,
}

// ---------------------------------------------------------------------------
// HostObject — Rust objects exposed as JS objects
// ---------------------------------------------------------------------------

#[repr(C)]
pub struct HermesABIHostObjectVTable {
    pub release: unsafe extern "C" fn(self_: *mut HermesABIHostObject),
    pub get: unsafe extern "C" fn(
        self_: *mut HermesABIHostObject,
        rt: *mut HermesABIRuntime,
        name: HermesABIPropNameID,
    ) -> HermesABIValueOrError,
    pub set: unsafe extern "C" fn(
        self_: *mut HermesABIHostObject,
        rt: *mut HermesABIRuntime,
        name: HermesABIPropNameID,
        value: *const HermesABIValue,
    ) -> HermesABIVoidOrError,
    pub get_own_keys: unsafe extern "C" fn(
        self_: *mut HermesABIHostObject,
        rt: *mut HermesABIRuntime,
    ) -> HermesABIPropNameIDListPtrOrError,
}

#[repr(C)]
pub struct HermesABIHostObject {
    pub vtable: *const HermesABIHostObjectVTable,
}

// ---------------------------------------------------------------------------
// NativeState — arbitrary native data attached to a JS object
// ---------------------------------------------------------------------------

#[repr(C)]
pub struct HermesABINativeStateVTable {
    pub release: unsafe extern "C" fn(self_: *mut HermesABINativeState),
}

#[repr(C)]
pub struct HermesABINativeState {
    pub vtable: *const HermesABINativeStateVTable,
}

// ---------------------------------------------------------------------------
// HermesABIRuntimeVTable — the full vtable for a runtime instance
// ---------------------------------------------------------------------------

#[repr(C)]
pub struct HermesABIRuntimeVTable {
    pub release: unsafe extern "C" fn(rt: *mut HermesABIRuntime),

    // Exception retrieval
    pub get_and_clear_js_error_value:
        unsafe extern "C" fn(rt: *mut HermesABIRuntime) -> HermesABIValue,
    pub get_and_clear_native_exception_message: unsafe extern "C" fn(
        rt: *mut HermesABIRuntime,
        msg_buf: *mut HermesABIGrowableBuffer,
    ),

    // Exception reporting (for use inside HostFunction / HostObject)
    pub set_js_error_value:
        unsafe extern "C" fn(rt: *mut HermesABIRuntime, error_value: *const HermesABIValue),
    pub set_native_exception_message:
        unsafe extern "C" fn(rt: *mut HermesABIRuntime, utf8: *const u8, length: size_t),

    // Reference cloning
    pub clone_propnameid:
        unsafe extern "C" fn(rt: *mut HermesABIRuntime, name: HermesABIPropNameID)
            -> HermesABIPropNameID,
    pub clone_string:
        unsafe extern "C" fn(rt: *mut HermesABIRuntime, str: HermesABIString) -> HermesABIString,
    pub clone_symbol: unsafe extern "C" fn(
        rt: *mut HermesABIRuntime,
        sym: HermesABISymbol,
    ) -> HermesABISymbol,
    pub clone_object: unsafe extern "C" fn(
        rt: *mut HermesABIRuntime,
        obj: HermesABIObject,
    ) -> HermesABIObject,
    pub clone_bigint: unsafe extern "C" fn(
        rt: *mut HermesABIRuntime,
        bigint: HermesABIBigInt,
    ) -> HermesABIBigInt,

    // Evaluation
    pub evaluate_javascript_source: unsafe extern "C" fn(
        rt: *mut HermesABIRuntime,
        buf: *mut HermesABIBuffer,
        source_url: *const c_char,
        source_url_len: size_t,
    ) -> HermesABIValueOrError,
    pub evaluate_hermes_bytecode: unsafe extern "C" fn(
        rt: *mut HermesABIRuntime,
        buf: *mut HermesABIBuffer,
        source_url: *const c_char,
        source_url_len: size_t,
    ) -> HermesABIValueOrError,

    // Global object
    pub get_global_object:
        unsafe extern "C" fn(rt: *mut HermesABIRuntime) -> HermesABIObject,

    // String creation
    pub create_string_from_utf8: unsafe extern "C" fn(
        rt: *mut HermesABIRuntime,
        utf8: *const u8,
        len: size_t,
    ) -> HermesABIStringOrError,

    // Object operations
    pub create_object:
        unsafe extern "C" fn(rt: *mut HermesABIRuntime) -> HermesABIObjectOrError,
    pub has_object_property_from_value: unsafe extern "C" fn(
        rt: *mut HermesABIRuntime,
        obj: HermesABIObject,
        key: *const HermesABIValue,
    ) -> HermesABIBoolOrError,
    pub has_object_property_from_propnameid: unsafe extern "C" fn(
        rt: *mut HermesABIRuntime,
        obj: HermesABIObject,
        name: HermesABIPropNameID,
    ) -> HermesABIBoolOrError,
    pub get_object_property_from_value: unsafe extern "C" fn(
        rt: *mut HermesABIRuntime,
        obj: HermesABIObject,
        key: *const HermesABIValue,
    ) -> HermesABIValueOrError,
    pub get_object_property_from_propnameid: unsafe extern "C" fn(
        rt: *mut HermesABIRuntime,
        obj: HermesABIObject,
        name: HermesABIPropNameID,
    ) -> HermesABIValueOrError,
    pub set_object_property_from_value: unsafe extern "C" fn(
        rt: *mut HermesABIRuntime,
        obj: HermesABIObject,
        key: *const HermesABIValue,
        value: *const HermesABIValue,
    ) -> HermesABIVoidOrError,
    pub set_object_property_from_propnameid: unsafe extern "C" fn(
        rt: *mut HermesABIRuntime,
        obj: HermesABIObject,
        name: HermesABIPropNameID,
        value: *const HermesABIValue,
    ) -> HermesABIVoidOrError,
    pub get_object_property_names: unsafe extern "C" fn(
        rt: *mut HermesABIRuntime,
        obj: HermesABIObject,
    ) -> HermesABIArrayOrError,
    pub set_object_external_memory_pressure: unsafe extern "C" fn(
        rt: *mut HermesABIRuntime,
        obj: HermesABIObject,
        amount: size_t,
    ) -> HermesABIVoidOrError,

    // Array operations
    pub create_array: unsafe extern "C" fn(
        rt: *mut HermesABIRuntime,
        length: size_t,
    ) -> HermesABIArrayOrError,
    pub get_array_length:
        unsafe extern "C" fn(rt: *mut HermesABIRuntime, arr: HermesABIArray) -> size_t,

    // ArrayBuffer
    pub create_arraybuffer_from_external_data: unsafe extern "C" fn(
        rt: *mut HermesABIRuntime,
        buf: *mut HermesABIMutableBuffer,
    ) -> HermesABIArrayBufferOrError,
    pub get_arraybuffer_data: unsafe extern "C" fn(
        rt: *mut HermesABIRuntime,
        ab: HermesABIArrayBuffer,
    ) -> HermesABIUint8PtrOrError,
    pub get_arraybuffer_size: unsafe extern "C" fn(
        rt: *mut HermesABIRuntime,
        ab: HermesABIArrayBuffer,
    ) -> HermesABISizeTOrError,

    // PropNameID
    pub create_propnameid_from_string: unsafe extern "C" fn(
        rt: *mut HermesABIRuntime,
        str: HermesABIString,
    ) -> HermesABIPropNameIDOrError,
    pub create_propnameid_from_symbol: unsafe extern "C" fn(
        rt: *mut HermesABIRuntime,
        sym: HermesABISymbol,
    ) -> HermesABIPropNameIDOrError,
    pub prop_name_id_equals: unsafe extern "C" fn(
        rt: *mut HermesABIRuntime,
        a: HermesABIPropNameID,
        b: HermesABIPropNameID,
    ) -> bool,

    // Function calls
    pub call: unsafe extern "C" fn(
        rt: *mut HermesABIRuntime,
        fn_: HermesABIFunction,
        js_this: *const HermesABIValue,
        args: *const HermesABIValue,
        arg_count: size_t,
    ) -> HermesABIValueOrError,
    pub call_as_constructor: unsafe extern "C" fn(
        rt: *mut HermesABIRuntime,
        fn_: HermesABIFunction,
        args: *const HermesABIValue,
        arg_count: size_t,
    ) -> HermesABIValueOrError,

    // HostFunction
    pub create_function_from_host_function: unsafe extern "C" fn(
        rt: *mut HermesABIRuntime,
        name: HermesABIPropNameID,
        length: c_uint,
        hf: *mut HermesABIHostFunction,
    ) -> HermesABIFunctionOrError,
    pub get_host_function: unsafe extern "C" fn(
        rt: *mut HermesABIRuntime,
        fn_: HermesABIFunction,
    ) -> *mut HermesABIHostFunction,

    // HostObject
    pub create_object_from_host_object: unsafe extern "C" fn(
        rt: *mut HermesABIRuntime,
        ho: *mut HermesABIHostObject,
    ) -> HermesABIObjectOrError,
    pub get_host_object: unsafe extern "C" fn(
        rt: *mut HermesABIRuntime,
        obj: HermesABIObject,
    ) -> *mut HermesABIHostObject,

    // NativeState
    pub get_native_state: unsafe extern "C" fn(
        rt: *mut HermesABIRuntime,
        obj: HermesABIObject,
    ) -> *mut HermesABINativeState,
    pub set_native_state: unsafe extern "C" fn(
        rt: *mut HermesABIRuntime,
        obj: HermesABIObject,
        ns: *mut HermesABINativeState,
    ) -> HermesABIVoidOrError,

    // Type checks
    pub object_is_array:
        unsafe extern "C" fn(rt: *mut HermesABIRuntime, obj: HermesABIObject) -> bool,
    pub object_is_arraybuffer:
        unsafe extern "C" fn(rt: *mut HermesABIRuntime, obj: HermesABIObject) -> bool,
    pub object_is_function:
        unsafe extern "C" fn(rt: *mut HermesABIRuntime, obj: HermesABIObject) -> bool,

    // WeakObject
    pub create_weak_object: unsafe extern "C" fn(
        rt: *mut HermesABIRuntime,
        obj: HermesABIObject,
    ) -> HermesABIWeakObjectOrError,
    pub lock_weak_object: unsafe extern "C" fn(
        rt: *mut HermesABIRuntime,
        wo: HermesABIWeakObject,
    ) -> HermesABIValue,

    // UTF-8 extraction
    pub get_utf8_from_string: unsafe extern "C" fn(
        rt: *mut HermesABIRuntime,
        str: HermesABIString,
        buf: *mut HermesABIGrowableBuffer,
    ),
    pub get_utf8_from_propnameid: unsafe extern "C" fn(
        rt: *mut HermesABIRuntime,
        name: HermesABIPropNameID,
        buf: *mut HermesABIGrowableBuffer,
    ),
    pub get_utf8_from_symbol: unsafe extern "C" fn(
        rt: *mut HermesABIRuntime,
        sym: HermesABISymbol,
        buf: *mut HermesABIGrowableBuffer,
    ),

    // instanceof / strict equality
    pub instance_of: unsafe extern "C" fn(
        rt: *mut HermesABIRuntime,
        obj: HermesABIObject,
        ctor: HermesABIFunction,
    ) -> HermesABIBoolOrError,
    pub strict_equals_symbol: unsafe extern "C" fn(
        rt: *mut HermesABIRuntime,
        a: HermesABISymbol,
        b: HermesABISymbol,
    ) -> bool,
    pub strict_equals_bigint: unsafe extern "C" fn(
        rt: *mut HermesABIRuntime,
        a: HermesABIBigInt,
        b: HermesABIBigInt,
    ) -> bool,
    pub strict_equals_string: unsafe extern "C" fn(
        rt: *mut HermesABIRuntime,
        a: HermesABIString,
        b: HermesABIString,
    ) -> bool,
    pub strict_equals_object: unsafe extern "C" fn(
        rt: *mut HermesABIRuntime,
        a: HermesABIObject,
        b: HermesABIObject,
    ) -> bool,

    // Microtask queue
    pub drain_microtasks: unsafe extern "C" fn(
        rt: *mut HermesABIRuntime,
        max_hint: c_int,
    ) -> HermesABIBoolOrError,

    // BigInt
    pub create_bigint_from_int64: unsafe extern "C" fn(
        rt: *mut HermesABIRuntime,
        value: i64,
    ) -> HermesABIBigIntOrError,
    pub create_bigint_from_uint64: unsafe extern "C" fn(
        rt: *mut HermesABIRuntime,
        value: u64,
    ) -> HermesABIBigIntOrError,
    pub bigint_is_int64:
        unsafe extern "C" fn(rt: *mut HermesABIRuntime, bigint: HermesABIBigInt) -> bool,
    pub bigint_is_uint64:
        unsafe extern "C" fn(rt: *mut HermesABIRuntime, bigint: HermesABIBigInt) -> bool,
    pub bigint_truncate_to_uint64:
        unsafe extern "C" fn(rt: *mut HermesABIRuntime, bigint: HermesABIBigInt) -> u64,
    pub bigint_to_string: unsafe extern "C" fn(
        rt: *mut HermesABIRuntime,
        bigint: HermesABIBigInt,
        radix: c_uint,
    ) -> HermesABIStringOrError,
}

// ---------------------------------------------------------------------------
// HermesABIRuntime — a runtime instance (vtable + state managed by Hermes)
// ---------------------------------------------------------------------------

/// A Hermes runtime instance. Created via `HermesABIVTable::make_hermes_runtime`
/// and destroyed via `HermesABIRuntimeVTable::release`.
#[repr(C)]
pub struct HermesABIRuntime {
    pub vt: *const HermesABIRuntimeVTable,
}

// ---------------------------------------------------------------------------
// HermesABIVTable — top-level entry point vtable
// ---------------------------------------------------------------------------

/// The top-level vtable obtained from `get_hermes_abi_vtable()`. Used to
/// create runtime instances and check bytecode buffers.
#[repr(C)]
pub struct HermesABIVTable {
    pub make_hermes_runtime: unsafe extern "C" fn(
        config: *const HermesABIRuntimeConfig,
    ) -> *mut HermesABIRuntime,
    pub is_hermes_bytecode: unsafe extern "C" fn(buf: *const u8, len: size_t) -> bool,
}

// ---------------------------------------------------------------------------
// Extern declaration of the library entry point
// ---------------------------------------------------------------------------

unsafe extern "C" {
    /// Entry point exported by the Hermes library (`hermes_vtable.h`).
    ///
    /// # TODO(platform-linking)
    /// The linker must be pointed at the platform-specific Hermes library:
    ///   iOS:     libhermes.a  — link via `build.rs` with `cargo:rustc-link-lib=static=hermes`
    ///   Android: libhermes.so — link via `build.rs` with `cargo:rustc-link-lib=hermes`
    pub fn get_hermes_abi_vtable() -> *const HermesABIVTable;
}
