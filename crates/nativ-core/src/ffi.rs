//! C ABI functions for communicating with the native runtime.
//!
//! On iOS: resolved at dlopen time via `-undefined dynamic_lookup`.
//! On Android: resolved at runtime via `dlsym` (linker namespace isolation
//! prevents direct linking from cache-loaded .so files).

#![allow(unsafe_op_in_unsafe_fn)]
use std::ffi::{c_char, c_void, c_float, c_double, c_int};

// ─── dlsym helper for Android ─────────────────────────────────────────

#[cfg(target_os = "android")]
unsafe extern "C" {
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
}

// On Android, all host function pointers are stored here.
// Populated by nativ_init_runtime() called from the host after dlopen.
#[cfg(target_os = "android")]
pub(crate) static mut HOST_LIB: *mut c_void = core::ptr::null_mut();

#[cfg(target_os = "android")]
unsafe extern "C" {
    fn dlopen(filename: *const c_char, flags: c_int) -> *mut c_void;
}

#[cfg(target_os = "android")]
unsafe fn resolve(name: &core::ffi::CStr) -> *mut c_void {
    unsafe {
        if HOST_LIB.is_null() { return core::ptr::null_mut(); }
        dlsym(HOST_LIB, name.as_ptr())
    }
}

/// Called by host after dlopen — passes the libnativruntime.so handle
/// so all dlsym calls can resolve against it.
#[cfg(target_os = "android")]
#[unsafe(no_mangle)]
pub extern "C" fn nativ_set_runtime_lib(handle: *mut c_void) {
    unsafe { HOST_LIB = handle; }
}

// ─── Registration functions ───────────────────────────────────────────

#[cfg(target_os = "ios")]
unsafe extern "C" {
    pub fn nativ_register_render(
        component_id: *const c_char,
        render_fn: unsafe extern "C" fn(*mut c_void, c_float, c_float, *mut c_void, *mut c_void),
    );
    pub fn nativ_register_sync(
        module_id: *const c_char,
        fn_name: *const c_char,
        f: extern "C" fn(*const c_char) -> *const c_char,
    );
}

// Android production (unified): direct extern — symbols in same .so
#[cfg(all(target_os = "android", unified))]
unsafe extern "C" {
    pub fn nativ_register_render(
        component_id: *const c_char,
        render_fn: unsafe extern "C" fn(*mut c_void, c_float, c_float, *mut c_void, *mut c_void),
    );
    pub fn nativ_register_sync(
        module_id: *const c_char,
        fn_name: *const c_char,
        f: extern "C" fn(*const c_char) -> *const c_char,
    );
}

// Android dev: resolve via dlsym (linker namespace isolation)
#[cfg(all(target_os = "android", not(unified)))]
pub unsafe fn nativ_register_render(
    component_id: *const c_char,
    render_fn: unsafe extern "C" fn(*mut c_void, c_float, c_float, *mut c_void, *mut c_void),
) {
    type F = unsafe extern "C" fn(*const c_char, unsafe extern "C" fn(*mut c_void, c_float, c_float, *mut c_void, *mut c_void));
    let sym = resolve(c"nativ_register_render");
    if !sym.is_null() { unsafe { (core::mem::transmute::<_, F>(sym))(component_id, render_fn) } }
}

#[cfg(all(target_os = "android", not(unified)))]
pub unsafe fn nativ_register_sync(
    module_id: *const c_char,
    fn_name: *const c_char,
    f: extern "C" fn(*const c_char) -> *const c_char,
) {
    type F = unsafe extern "C" fn(*const c_char, *const c_char, extern "C" fn(*const c_char) -> *const c_char);
    let sym = resolve(c"nativ_register_sync");
    if !sym.is_null() { unsafe { (core::mem::transmute::<_, F>(sym))(module_id, fn_name, f) } }
}

// ─── JSI value access (read props from jsi::Object) ──────────────────

#[cfg(target_os = "ios")]
unsafe extern "C" {
    pub fn nativ_jsi_get_string(
        runtime: *mut c_void, object: *mut c_void, prop_name: *const c_char
    ) -> *const c_char;

    pub fn nativ_jsi_get_number(
        runtime: *mut c_void, object: *mut c_void, prop_name: *const c_char
    ) -> c_double;

    pub fn nativ_jsi_get_bool(
        runtime: *mut c_void, object: *mut c_void, prop_name: *const c_char
    ) -> c_int;

    pub fn nativ_jsi_has_prop(
        runtime: *mut c_void, object: *mut c_void, prop_name: *const c_char
    ) -> c_int;

    pub fn nativ_jsi_call_function(
        runtime: *mut c_void, object: *mut c_void, prop_name: *const c_char
    );

    pub fn nativ_jsi_call_function_with_string(
        runtime: *mut c_void, object: *mut c_void,
        prop_name: *const c_char, arg: *const c_char
    );
}

// Android production (unified): direct extern for JSI functions
#[cfg(all(target_os = "android", unified))]
unsafe extern "C" {
    pub fn nativ_jsi_get_string(runtime: *mut c_void, object: *mut c_void, prop_name: *const c_char) -> *const c_char;
    pub fn nativ_jsi_get_number(runtime: *mut c_void, object: *mut c_void, prop_name: *const c_char) -> c_double;
    pub fn nativ_jsi_get_bool(runtime: *mut c_void, object: *mut c_void, prop_name: *const c_char) -> c_int;
    pub fn nativ_jsi_has_prop(runtime: *mut c_void, object: *mut c_void, prop_name: *const c_char) -> c_int;
    pub fn nativ_jsi_call_function(runtime: *mut c_void, object: *mut c_void, prop_name: *const c_char);
    pub fn nativ_jsi_call_function_with_string(runtime: *mut c_void, object: *mut c_void, prop_name: *const c_char, arg: *const c_char);
}

// Android dev: resolve via dlsym from libnativruntime.so
#[cfg(all(target_os = "android", not(unified)))]
pub unsafe fn nativ_jsi_get_string(
    runtime: *mut c_void, object: *mut c_void, prop_name: *const c_char
) -> *const c_char {
    type F = unsafe extern "C" fn(*mut c_void, *mut c_void, *const c_char) -> *const c_char;
    let sym = resolve(c"nativ_jsi_get_string");
    if sym.is_null() { return core::ptr::null(); }
    unsafe { (core::mem::transmute::<_, F>(sym))(runtime, object, prop_name) }
}

#[cfg(all(target_os = "android", not(unified)))]
pub unsafe fn nativ_jsi_get_number(
    runtime: *mut c_void, object: *mut c_void, prop_name: *const c_char
) -> c_double {
    type F = unsafe extern "C" fn(*mut c_void, *mut c_void, *const c_char) -> c_double;
    let sym = resolve(c"nativ_jsi_get_number");
    if sym.is_null() { return 0.0; }
    unsafe { (core::mem::transmute::<_, F>(sym))(runtime, object, prop_name) }
}

#[cfg(all(target_os = "android", not(unified)))]
pub unsafe fn nativ_jsi_get_bool(
    runtime: *mut c_void, object: *mut c_void, prop_name: *const c_char
) -> c_int {
    type F = unsafe extern "C" fn(*mut c_void, *mut c_void, *const c_char) -> c_int;
    let sym = resolve(c"nativ_jsi_get_bool");
    if sym.is_null() { return 0; }
    unsafe { (core::mem::transmute::<_, F>(sym))(runtime, object, prop_name) }
}

#[cfg(all(target_os = "android", not(unified)))]
pub unsafe fn nativ_jsi_has_prop(
    runtime: *mut c_void, object: *mut c_void, prop_name: *const c_char
) -> c_int {
    type F = unsafe extern "C" fn(*mut c_void, *mut c_void, *const c_char) -> c_int;
    let sym = resolve(c"nativ_jsi_has_prop");
    if sym.is_null() { return 0; }
    unsafe { (core::mem::transmute::<_, F>(sym))(runtime, object, prop_name) }
}

#[cfg(all(target_os = "android", not(unified)))]
pub unsafe fn nativ_jsi_call_function(
    runtime: *mut c_void, object: *mut c_void, prop_name: *const c_char
) {
    type F = unsafe extern "C" fn(*mut c_void, *mut c_void, *const c_char);
    let sym = resolve(c"nativ_jsi_call_function");
    if !sym.is_null() { unsafe { (core::mem::transmute::<_, F>(sym))(runtime, object, prop_name) } }
}

#[cfg(all(target_os = "android", not(unified)))]
pub unsafe fn nativ_jsi_call_function_with_string(
    runtime: *mut c_void, object: *mut c_void,
    prop_name: *const c_char, arg: *const c_char
) {
    type F = unsafe extern "C" fn(*mut c_void, *mut c_void, *const c_char, *const c_char);
    let sym = resolve(c"nativ_jsi_call_function_with_string");
    if !sym.is_null() { unsafe { (core::mem::transmute::<_, F>(sym))(runtime, object, prop_name, arg) } }
}

// ─── Android view manipulation (JNI-backed, in libnativruntime.so) ───

// Android production (unified): direct extern — symbols in same .so
#[cfg(all(target_os = "android", unified))]
unsafe extern "C" {
    pub fn nativ_view_set_background_color(
        view: *mut c_void, r: c_double, g: c_double, b: c_double, a: c_double,
    );
    pub fn nativ_view_add_label(
        parent: *mut c_void, text: *const c_char,
        r: c_double, g: c_double, b: c_double,
        width: c_double, height: c_double,
    );
    pub fn nativ_view_add_subview(
        parent: *mut c_void,
        x: c_double, y: c_double, w: c_double, h: c_double,
        r: c_double, g: c_double, b: c_double, a: c_double,
    ) -> *mut c_void;
}

// Android dev: resolve via dlsym
#[cfg(all(target_os = "android", not(unified)))]
pub unsafe fn nativ_view_set_background_color(
    view: *mut c_void, r: c_double, g: c_double, b: c_double, a: c_double,
) {
    type F = unsafe extern "C" fn(*mut c_void, c_double, c_double, c_double, c_double);
    let sym = resolve(c"nativ_view_set_background_color");
    if !sym.is_null() { unsafe { (core::mem::transmute::<_, F>(sym))(view, r, g, b, a) } }
}

#[cfg(all(target_os = "android", not(unified)))]
pub unsafe fn nativ_view_add_label(
    parent: *mut c_void, text: *const c_char,
    r: c_double, g: c_double, b: c_double,
    width: c_double, height: c_double,
) {
    type F = unsafe extern "C" fn(*mut c_void, *const c_char, c_double, c_double, c_double, c_double, c_double);
    let sym = resolve(c"nativ_view_add_label");
    if !sym.is_null() { unsafe { (core::mem::transmute::<_, F>(sym))(parent, text, r, g, b, width, height) } }
}

#[cfg(all(target_os = "android", not(unified)))]
pub unsafe fn nativ_view_add_subview(
    parent: *mut c_void,
    x: c_double, y: c_double, w: c_double, h: c_double,
    r: c_double, g: c_double, b: c_double, a: c_double,
) -> *mut c_void {
    type F = unsafe extern "C" fn(*mut c_void, c_double, c_double, c_double, c_double, c_double, c_double, c_double, c_double) -> *mut c_void;
    let sym = resolve(c"nativ_view_add_subview");
    if sym.is_null() { return core::ptr::null_mut(); }
    unsafe { (core::mem::transmute::<_, F>(sym))(parent, x, y, w, h, r, g, b, a) }
}
