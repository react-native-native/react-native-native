//! iOS AppDelegate implemented via `objc2`.
//!
//! Defines a minimal `UIApplicationDelegate` that:
//! - In `application:didFinishLaunchingWithOptions:` bootstraps the Ferrum
//!   runtime, evaluates the JS bundle, and creates a visible `UIWindow`.
//! - Provides `run_application()` which calls `UIApplicationMain` to hand the
//!   process to the UIKit run loop.
//!
//! # objc2 pattern
//!
//! objc2 uses Rust `declare_class!` to declare an Objective-C class at
//! runtime. The macro generates the necessary ObjC metadata and registers the
//! class with the ObjC runtime on first use.

use objc2::rc::Retained;
use objc2::{declare_class, mutability, ClassType, DeclaredClass};
use objc2_foundation::{CGPoint, CGRect, CGSize, MainThreadMarker, NSBundle, NSString};
use objc2_foundation::NSObjectProtocol;
use objc2_ui_kit::{
    UIApplication, UIApplicationDelegate, UIColor, UILabel, UIScreen, UIView, UIViewController,
    UIWindow,
};

use crate::{bootstrap_ferrum_runtime, FERRUM_INIT};

// ---------------------------------------------------------------------------
// AppDelegate class definition
// ---------------------------------------------------------------------------

/// Ivars placeholder — Phase 0 stores window lifetime via `mem::forget`.
/// Phase 1 will replace this with proper ObjC ivar storage.
pub struct AppDelegateIvars {}

declare_class!(
    pub struct AppDelegate;

    // SAFETY:
    // - NSObject has no subclassing requirements.
    // - UIApplicationDelegate requires IsMainThreadOnly, so MainThreadOnly is
    //   the correct mutability marker.
    // - AppDelegate does not implement Drop.
    unsafe impl ClassType for AppDelegate {
        type Super = objc2::runtime::NSObject;
        type Mutability = mutability::MainThreadOnly;
        const NAME: &'static str = "FerrumAppDelegate";
    }

    impl DeclaredClass for AppDelegate {
        type Ivars = AppDelegateIvars;
    }

    // NSObjectProtocol is required by UIApplicationDelegate.
    unsafe impl NSObjectProtocol for AppDelegate {}

    unsafe impl UIApplicationDelegate for AppDelegate {
        /// Called on the main thread after the app finishes launching.
        ///
        /// # Safety
        ///
        /// All pointer arguments are valid ObjC objects provided by UIKit.
        #[method(application:didFinishLaunchingWithOptions:)]
        unsafe fn application_did_finish_launching(
            &self,
            _application: &UIApplication,
            _launch_options: Option<&objc2_foundation::NSDictionary>,
        ) -> bool {
            log::info!("ferrum-ios: applicationDidFinishLaunching");

            // Load the JS bundle from the app bundle resources.
            let bundle_result = load_bundle_from_resources();

            let result_message = match bundle_result {
                Ok(bundle_bytes) => {
                    log::info!(
                        "ferrum-ios: loaded JS bundle ({} bytes)",
                        bundle_bytes.len()
                    );
                    match bootstrap_ferrum_runtime(&bundle_bytes) {
                        Ok(output) => {
                            log::info!("ferrum-ios: runtime bootstrap succeeded: {output}");
                            format!("Ferrum OK: {output}")
                        }
                        Err(e) => {
                            log::error!("ferrum-ios: runtime bootstrap failed: {e}");
                            format!("Ferrum ERROR: {e}")
                        }
                    }
                }
                Err(e) => {
                    log::error!("ferrum-ios: bundle load failed: {e}");
                    format!("Bundle ERROR: {e}")
                }
            };

            // Cache the result so the display link can read it.
            let _ = FERRUM_INIT.set(result_message.clone());

            // SAFETY: This callback always runs on the main thread.
            let mtm = unsafe { MainThreadMarker::new_unchecked() };

            // Create the UIWindow and a root view controller with a label.
            // SAFETY: create_window uses only main-thread UIKit APIs; we are
            // on the main thread inside applicationDidFinishLaunching.
            let window = unsafe { create_window(mtm, &result_message) };
            // Retain the window for the process lifetime so ARC doesn't release it.
            // TODO(Phase 1): store in a proper ivar via objc2 ivar mechanism.
            std::mem::forget(window);

            // Register the CADisplayLink for Phase 1 frame timing.
            crate::display_link::register_display_link();

            true
        }
    }
);

// ---------------------------------------------------------------------------
// Window and view setup
// ---------------------------------------------------------------------------

/// Creates a `UIWindow` covering the full screen with a status label.
///
/// Uses frame-based layout (Phase 0) — no Auto Layout constraints needed.
///
/// # Safety
///
/// Must be called from the main thread after UIKit has initialized `UIScreen`.
unsafe fn create_window(mtm: MainThreadMarker, result_message: &str) -> Retained<UIWindow> {
    // UIScreen::mainScreen is deprecated in iOS 16+ but remains functional.
    // Phase 0 uses it for simplicity; Phase 1 can switch to UIWindowScene.screen.
    // SAFETY: mtm confirms we are on the main thread.
    #[allow(deprecated)]
    let screen_bounds = UIScreen::mainScreen(mtm).bounds();

    // UIWindow::initWithFrame: is the designated initializer for Phase 0.
    // MainThreadOnly types must be allocated via mtm.alloc::<T>() rather than
    // ClassType::alloc(), which requires IsAllocableAnyThread.
    // SAFETY: initWithFrame: is a valid designated initializer for UIWindow.
    let window = unsafe { UIWindow::initWithFrame(mtm.alloc::<UIWindow>(), screen_bounds) };

    // Dark background so the label is readable on a physical device.
    // SAFETY: blackColor and setBackgroundColor are always valid.
    let black = unsafe { UIColor::blackColor() };
    window.setBackgroundColor(Some(&black));

    // Root UIViewController.
    // SAFETY: UIViewController::new is safe on the main thread.
    let root_vc = unsafe { UIViewController::new(mtm) };

    // UILabel for bootstrap result display.
    // SAFETY: UILabel::new is safe on the main thread.
    let label = unsafe { UILabel::new(mtm) };

    // Set the label text to the Ferrum bootstrap result.
    let ns_text = NSString::from_str(result_message);
    // SAFETY: setText: is a standard setter for UILabel.
    unsafe { label.setText(Some(&ns_text)) };

    let white = unsafe { UIColor::whiteColor() };
    // SAFETY: setTextColor: is a standard setter for UILabel.
    unsafe { label.setTextColor(Some(&white)) };

    // Allow the label to wrap across multiple lines.
    // SAFETY: setNumberOfLines: is a standard setter for UILabel.
    unsafe { label.setNumberOfLines(0) };

    // Frame-based layout: position the label at 10 % inset, 20 % from top,
    // 80 % of screen width and 60 % of height — readable without Auto Layout.
    let label_frame = CGRect {
        origin: CGPoint {
            x: screen_bounds.size.width * 0.1,
            y: screen_bounds.size.height * 0.2,
        },
        size: CGSize {
            width: screen_bounds.size.width * 0.8,
            height: screen_bounds.size.height * 0.6,
        },
    };
    label.setFrame(label_frame);

    // Add the label to the root view controller's view.
    // UIViewController::view() returns Option<Retained<UIView>>; non-nil after init.
    // SAFETY: The view is always valid after UIViewController is initialized.
    let root_view: Retained<UIView> = root_vc
        .view()
        .expect("UIViewController.view must not be nil after init");
    // SAFETY: addSubview: is main-thread-safe.
    unsafe { root_view.addSubview(&label) };

    // Attach the root view controller and show the window.
    // SAFETY: setRootViewController:/makeKeyAndVisible are safe after UIApplicationMain.
    window.setRootViewController(Some(&root_vc));
    window.makeKeyAndVisible();

    log::info!("ferrum-ios: UIWindow created and made key");
    window
}

// ---------------------------------------------------------------------------
// Bundle resource loading
// ---------------------------------------------------------------------------

/// Loads `bundle.js` from the app bundle's main resource directory.
///
/// On iOS the JS file is copied into the `.app` directory by the Xcode build
/// phase. `NSBundle.mainBundle.pathForResource:ofType:` resolves the path.
///
/// Returns the raw bytes of the file.
fn load_bundle_from_resources() -> Result<Vec<u8>, String> {
    // NSBundle::mainBundle() is a safe class method in objc2-foundation 0.2.
    let main_bundle = NSBundle::mainBundle();
    let resource_name = NSString::from_str("bundle");
    let resource_type = NSString::from_str("js");

    // SAFETY: pathForResource:ofType: is a valid instance method on NSBundle.
    let path: Option<Retained<NSString>> = unsafe {
        main_bundle.pathForResource_ofType(Some(&resource_name), Some(&resource_type))
    };

    let path = path.ok_or_else(|| {
        "bundle.js not found in app bundle — ensure it is in the Xcode 'Copy Bundle Resources' phase".to_string()
    })?;

    let path_str = path.to_string();
    std::fs::read(&path_str)
        .map_err(|e| format!("read {path_str}: {e}"))
}

// ---------------------------------------------------------------------------
// UIApplicationMain entry
// ---------------------------------------------------------------------------

/// Starts the iOS application by calling `UIApplicationMain`.
///
/// This function is called from the C `main` entry point in `lib.rs`. It
/// registers the `FerrumAppDelegate` class name and passes it to
/// `UIApplicationMain`, which then instantiates the delegate and drives the
/// run loop indefinitely.
///
/// # Safety
///
/// - `argc` and `argv` are the values received from the OS `main()` call.
/// - `UIApplicationMain` is called exactly once per process lifetime.
/// - Returns only on process exit; the return value is always passed to `exit()`.
pub unsafe fn run_application(
    argc: std::ffi::c_int,
    argv: *mut *mut std::ffi::c_char,
) -> std::ffi::c_int {
    // Force the FerrumAppDelegate class to register with the ObjC runtime.
    // declare_class! uses lazy registration — without this call, UIApplicationMain
    // will fail to find the class by name and assert.
    let _ = AppDelegate::class();

    // Register the delegate class name as an NSString.
    let delegate_class_name = NSString::from_str("FerrumAppDelegate");

    // UIApplicationMain is a plain C function — declare and call it directly.
    // It is not an ObjC message send; objc2-ui-kit does not wrap it.
    //
    // Signature: int UIApplicationMain(int argc, char **argv,
    //   NSString *principalClassName, NSString *delegateClassName)
    // We pass NSString* object pointers for the last two arguments.
    #[link(name = "UIKit", kind = "framework")]
    unsafe extern "C" {
        fn UIApplicationMain(
            argc: std::ffi::c_int,
            argv: *mut *mut std::ffi::c_char,
            principal_class_name: *const std::ffi::c_void,
            delegate_class_name: *const std::ffi::c_void,
        ) -> std::ffi::c_int;
    }

    let principal_class_name = NSString::from_str("UIApplication");

    // SAFETY: argc/argv are valid OS values; `Retained::as_ptr` returns
    // valid NSString* pointers that remain live because both variables
    // are in scope for the entire call (UIApplicationMain never returns).
    unsafe {
        UIApplicationMain(
            argc,
            argv,
            Retained::as_ptr(&principal_class_name).cast(),
            Retained::as_ptr(&delegate_class_name).cast(),
        )
    }
}
