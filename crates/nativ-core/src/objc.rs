//! ObjC runtime FFI — typed wrappers around objc_msgSend.
//!
//! These are the building blocks that `NativeViewHandle` uses.
//! They can also be used directly for advanced UIKit access.

use std::ffi::{c_char, c_void, CString};

#[link(name = "objc", kind = "dylib")]
unsafe extern "C" {
    fn objc_getClass(name: *const c_char) -> *mut c_void;
    fn sel_registerName(name: *const c_char) -> *mut c_void;
    fn objc_msgSend() -> *mut c_void;
}

// Typed function pointer casts for objc_msgSend
type SendPtr = unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void;
type SendVoidPtr = unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void);
type SendVoid = unsafe extern "C" fn(*mut c_void, *mut c_void);

/// Get an ObjC class by name.
pub fn class(name: &str) -> *mut c_void {
    let c = CString::new(name).unwrap();
    unsafe { objc_getClass(c.as_ptr()) }
}

/// Get an ObjC selector.
pub fn sel(name: &str) -> *mut c_void {
    let c = CString::new(name).unwrap();
    unsafe { sel_registerName(c.as_ptr()) }
}

/// Alloc + init a new ObjC object.
pub fn new_instance(cls: &str) -> *mut c_void {
    let alloc: SendPtr = unsafe { std::mem::transmute(objc_msgSend as *mut c_void) };
    let init: SendPtr = unsafe { std::mem::transmute(objc_msgSend as *mut c_void) };
    unsafe { init(alloc(class(cls), sel("alloc")), sel("init")) }
}

/// Create an NSString from a Rust &str.
pub fn nsstring(s: &str) -> *mut c_void {
    let cstr = CString::new(s).unwrap();
    let send: unsafe extern "C" fn(*mut c_void, *mut c_void, *const c_char) -> *mut c_void =
        unsafe { std::mem::transmute(objc_msgSend as *mut c_void) };
    unsafe { send(class("NSString"), sel("stringWithUTF8String:"), cstr.as_ptr()) }
}

/// Create a UIColor from RGBA (0.0–1.0).
pub fn uicolor(r: f64, g: f64, b: f64, a: f64) -> *mut c_void {
    let send: unsafe extern "C" fn(*mut c_void, *mut c_void, f64, f64, f64, f64) -> *mut c_void =
        unsafe { std::mem::transmute(objc_msgSend as *mut c_void) };
    unsafe { send(class("UIColor"), sel("colorWithRed:green:blue:alpha:"), r, g, b, a) }
}

/// Send a message with one pointer arg (e.g., setBackgroundColor:, addSubview:, setText:).
pub fn send_void_ptr(obj: *mut c_void, selector: &str, arg: *mut c_void) {
    let send: SendVoidPtr = unsafe { std::mem::transmute(objc_msgSend as *mut c_void) };
    unsafe { send(obj, sel(selector), arg); }
}

/// Send a message with one i64 arg (e.g., setTextAlignment:).
pub fn send_void_i64(obj: *mut c_void, selector: &str, arg: i64) {
    let send: unsafe extern "C" fn(*mut c_void, *mut c_void, i64) =
        unsafe { std::mem::transmute(objc_msgSend as *mut c_void) };
    unsafe { send(obj, sel(selector), arg); }
}

/// Send a message with no args (e.g., sizeToFit).
pub fn send_void(obj: *mut c_void, selector: &str) {
    let send: SendVoid = unsafe { std::mem::transmute(objc_msgSend as *mut c_void) };
    unsafe { send(obj, sel(selector)); }
}

/// Send a message that returns a pointer (e.g., alloc, init).
pub fn send_ptr(obj: *mut c_void, selector: &str) -> *mut c_void {
    let send: SendPtr = unsafe { std::mem::transmute(objc_msgSend as *mut c_void) };
    unsafe { send(obj, sel(selector)) }
}

/// Set the frame of a UIView (x, y, w, h). CGRect is 4 doubles on arm64.
pub fn set_frame(view: *mut c_void, x: f64, y: f64, w: f64, h: f64) {
    let send: unsafe extern "C" fn(*mut c_void, *mut c_void, f64, f64, f64, f64) =
        unsafe { std::mem::transmute(objc_msgSend as *mut c_void) };
    unsafe { send(view, sel("setFrame:"), x, y, w, h); }
}

/// Send a message that returns a f64 (e.g., [UIScreen scale]).
pub fn send_f64(obj: *mut c_void, selector: &str) -> f64 {
    let send: unsafe extern "C" fn(*mut c_void, *mut c_void) -> f64 =
        unsafe { std::mem::transmute(objc_msgSend as *mut c_void) };
    unsafe { send(obj, sel(selector)) }
}

/// Send a message with one f64 arg (e.g., setContentsScale:).
pub fn send_void_f64(obj: *mut c_void, selector: &str, arg: f64) {
    let send: unsafe extern "C" fn(*mut c_void, *mut c_void, f64) =
        unsafe { std::mem::transmute(objc_msgSend as *mut c_void) };
    unsafe { send(obj, sel(selector), arg); }
}

/// Send a message with one u64 arg (e.g., setPixelFormat:).
pub fn send_void_u64(obj: *mut c_void, selector: &str, arg: u64) {
    let send: unsafe extern "C" fn(*mut c_void, *mut c_void, u64) =
        unsafe { std::mem::transmute(objc_msgSend as *mut c_void) };
    unsafe { send(obj, sel(selector), arg); }
}

/// Send a message with a CGSize arg (two f64s).
pub fn send_void_cgsize(obj: *mut c_void, selector: &str, w: f64, h: f64) {
    let send: unsafe extern "C" fn(*mut c_void, *mut c_void, f64, f64) =
        unsafe { std::mem::transmute(objc_msgSend as *mut c_void) };
    unsafe { send(obj, sel(selector), w, h); }
}
