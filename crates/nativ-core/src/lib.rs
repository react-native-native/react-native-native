//! `nativ-core` — core types for react-native-native.
//!
//! Provides `NativeView`, `NativeViewHandle`, and the ObjC runtime FFI
//! needed to create UIKit views from Rust.
//!
//! ```rust
//! use nativ_core::prelude::*;
//!
//! #[component]
//! pub struct MyView;
//!
//! impl NativeView for MyView {
//!     fn mount(&mut self, view: NativeViewHandle) {
//!         view.set_background_color(1.0, 0.0, 0.0, 1.0);
//!         view.add_label("Hello!", 1.0, 1.0, 1.0);
//!     }
//! }
//! ```

#[cfg(target_os = "ios")]
pub mod objc;
pub mod ffi;
pub mod props;

use std::ffi::c_void;

// Re-export the proc macros
pub use nativ_macros::{component, function};

/// A handle to the native UIView that a component renders into.
///
/// Provides a safe API for creating UIKit views via ObjC runtime calls.
/// The handle is valid only during the `mount` call.
pub struct NativeViewHandle {
    view: *mut c_void,
    width: f32,
    height: f32,
}

// SAFETY: The raw pointer is a UIView* owned by UIKit on the main thread.
// Components that use Send must dispatch UIKit calls back to main.
unsafe impl Send for NativeViewHandle {}

impl NativeViewHandle {
    /// Create a new handle. Called by the generated render function.
    pub fn new(view: *mut c_void, width: f32, height: f32) -> Self {
        Self { view, width, height }
    }

    /// Returns true if the view has been laid out (non-zero size).
    /// GPU components should skip rendering until this returns true.
    pub fn has_size(&self) -> bool {
        self.width > 0.0 && self.height > 0.0
    }

    /// Get the view width in points.
    pub fn width(&self) -> f32 {
        self.width
    }

    /// Get the view height in points.
    pub fn height(&self) -> f32 {
        self.height
    }

    // ─── iOS-specific methods (ObjC runtime) ────────────────────────────
    #[cfg(target_os = "ios")]
    /// Set the background color (RGBA, 0.0–1.0).
    pub fn set_background_color(&self, r: f64, g: f64, b: f64, a: f64) {
        let color = objc::uicolor(r, g, b, a);
        objc::send_void_ptr(self.view, "setBackgroundColor:", color);
    }

    #[cfg(target_os = "ios")]
    /// Add a centered label with the given text and color.
    pub fn add_label(&self, text: &str, r: f64, g: f64, b: f64) {
        let label = objc::new_instance("UILabel");
        let w = self.width as f64;
        let h = self.height as f64;

        objc::send_void_ptr(label, "setText:", objc::nsstring(text));
        objc::send_void_ptr(label, "setTextColor:", objc::uicolor(r, g, b, 1.0));
        objc::send_void_i64(label, "setTextAlignment:", 1); // NSTextAlignmentCenter
        objc::set_frame(label, 0.0, 0.0, w, h);
        objc::send_void_ptr(self.view, "addSubview:", label);
    }

    #[cfg(target_os = "ios")]
    /// Add a raw UIView subview with the given frame and background color.
    pub fn add_view(&self, x: f64, y: f64, w: f64, h: f64, r: f64, g: f64, b: f64, a: f64) -> *mut c_void {
        let view = objc::new_instance("UIView");
        objc::set_frame(view, x, y, w, h);
        objc::send_void_ptr(view, "setBackgroundColor:", objc::uicolor(r, g, b, a));
        objc::send_void_ptr(self.view, "addSubview:", view);
        view
    }

    // ─── Android-specific methods (JNI, via libnativruntime.so) ────────
    #[cfg(target_os = "android")]
    /// Set the background color (RGBA, 0.0–1.0).
    pub fn set_background_color(&self, r: f64, g: f64, b: f64, a: f64) {
        unsafe { ffi::nativ_view_set_background_color(self.view, r, g, b, a); }
    }

    #[cfg(target_os = "android")]
    /// Add a centered label with the given text and color.
    pub fn add_label(&self, text: &str, r: f64, g: f64, b: f64) {
        let ctext = std::ffi::CString::new(text).unwrap();
        unsafe {
            ffi::nativ_view_add_label(
                self.view, ctext.as_ptr(), r, g, b,
                self.width as f64, self.height as f64,
            );
        }
    }

    #[cfg(target_os = "android")]
    /// Add a child View with position, size, and background color.
    pub fn add_view(&self, x: f64, y: f64, w: f64, h: f64, r: f64, g: f64, b: f64, a: f64) -> *mut c_void {
        unsafe { ffi::nativ_view_add_subview(self.view, x, y, w, h, r, g, b, a) }
    }

    /// Get the raw UIView pointer for advanced use.
    pub fn raw_view(&self) -> *mut c_void {
        self.view
    }

    #[cfg(target_os = "ios")]
    /// Get a CAMetalLayer for GPU rendering (wgpu, egui, Metal, etc.).
    ///
    /// Creates a CAMetalLayer, sets its frame and contentsScale to match the
    /// view, adds it as a sublayer, and returns the raw pointer. Pass this to
    /// `wgpu::Instance::create_surface_from_core_animation_layer()`.
    pub fn metal_layer(&self) -> *mut c_void {
        let layer = objc::new_instance("CAMetalLayer");
        let w = self.width as f64;
        let h = self.height as f64;

        objc::set_frame(layer, 0.0, 0.0, w, h);

        // contentsScale = UIScreen.mainScreen.scale
        let scale = objc::send_f64(objc::send_ptr(objc::class("UIScreen"), "mainScreen"), "scale");
        objc::send_void_f64(layer, "setContentsScale:", scale);

        // Set pixel format to BGRA8 (default for wgpu Metal backend)
        // MTLPixelFormatBGRA8Unorm = 80
        objc::send_void_u64(layer, "setPixelFormat:", 80);

        // Set drawable size
        objc::send_void_cgsize(layer, "setDrawableSize:", w * scale, h * scale);

        // Add as sublayer of the view's layer
        let view_layer = objc::send_ptr(self.view, "layer");
        objc::send_void_ptr(view_layer, "addSublayer:", layer);

        layer
    }

    #[cfg(target_os = "ios")]
    /// Get the raw CALayer of the view.
    pub fn layer(&self) -> *mut c_void {
        objc::send_ptr(self.view, "layer")
    }
}

/// Trait for native view components.
///
/// Implement this on a struct marked with `#[component]` to define
/// what the component renders.
pub trait NativeView {
    /// Called when the component mounts or re-renders.
    fn mount(&mut self, view: NativeViewHandle);
}

/// Prelude — import everything needed for a component file.
pub mod prelude {
    pub use crate::{NativeView, NativeViewHandle};
    pub use crate::props::{Props, Callback};
    pub use nativ_macros::{component, function};
}
