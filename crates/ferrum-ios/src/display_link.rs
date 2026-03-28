//! CADisplayLink integration for iOS frame timing.
//!
//! Registers a `CADisplayLink` on the main run loop so Ferrum can hook into
//! the screen's vsync signal. In Phase 1 this drives `requestAnimationFrame`
//! callbacks and Fabric's shadow tree commit cycle.
//!
//! # Threading
//!
//! `CADisplayLink` must be added to a run loop. We add it to
//! `NSRunLoop.mainRunLoop` with the `NSRunLoopCommonModes` mode so it fires
//! during tracking events (scroll view panning) as well. The selector fires on
//! the main thread.
//!
//! # Safety invariant
//!
//! The target object (`FerrumDisplayLinkTarget`) must outlive the
//! `CADisplayLink`. We use `Box::leak` to give it a static lifetime for Phase
//! 0. Phase 1 should store it in the `AppDelegate` ivar instead.

use crate::FRAME_COUNTER;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObject};
use objc2::{declare_class, msg_send_id, mutability, sel, ClassType, DeclaredClass};
use objc2_foundation::{NSRunLoop, NSRunLoopCommonModes};
use objc2_quartz_core::CADisplayLink;
use std::sync::atomic::Ordering;

// ---------------------------------------------------------------------------
// Target object for the CADisplayLink selector
// ---------------------------------------------------------------------------

// ObjC target object that receives the `displayLinkFired:` selector.
//
// `CADisplayLink` requires a target/selector pair. We define a minimal ObjC
// class here rather than using a raw function pointer because the ObjC runtime
// expects a `(id, SEL, CADisplayLink*)` message dispatch.
// Note: doc comments (///) outside declare_class! do not propagate into the
// generated type, so regular comments are used here.
declare_class!(
    pub struct FerrumDisplayLink;

    // SAFETY:
    // - NSObject has no subclassing requirements.
    // - InteriorMutable is appropriate for a plain NSObject subclass with no
    //   UIKit thread requirements. The display link fires on the main thread
    //   but the class itself has no MainThreadOnly constraints.
    // - FerrumDisplayLink does not implement Drop.
    unsafe impl ClassType for FerrumDisplayLink {
        type Super = NSObject;
        type Mutability = mutability::InteriorMutable;
        const NAME: &'static str = "FerrumDisplayLinkTarget";
    }

    impl DeclaredClass for FerrumDisplayLink {
        type Ivars = ();
    }

    unsafe impl FerrumDisplayLink {
        /// Fires on every vsync frame on the main thread.
        ///
        /// In Phase 0 this increments a counter and logs once per second.
        /// In Phase 1 this will call `ferrum_core::tick(timestamp_ns)`.
        ///
        /// # Safety
        ///
        /// `display_link` is a valid `CADisplayLink` object managed by UIKit.
        /// All accesses go through the `objc2` safe wrapper.
        #[method(displayLinkFired:)]
        unsafe fn display_link_fired(&self, display_link: &CADisplayLink) {
            let count = FRAME_COUNTER.fetch_add(1, Ordering::Relaxed) + 1;

            // Log once per second at 60 fps to avoid flooding os_log.
            if count % 60 == 0 {
                // Retrieve the timestamp from the display link for Phase 1 use.
                // SAFETY: timestamp is a C double property on CADisplayLink.
                let timestamp = unsafe { display_link.timestamp() };
                log::debug!(
                    "ferrum-ios: frame {count}, timestamp={timestamp:.3}"
                );
            }

            // TODO(Phase 1): call ferrum_core::tick(timestamp_ns) to drive
            // requestAnimationFrame callbacks and Fabric shadow tree commits.
        }
    }
);

impl FerrumDisplayLink {
    fn new() -> Retained<Self> {
        // SAFETY: `init` is a valid ObjC initializer for NSObject subclasses.
        // msg_send_id! is required for init-family methods that return objects.
        unsafe { msg_send_id![Self::alloc(), init] }
    }
}

// ---------------------------------------------------------------------------
// Public registration function
// ---------------------------------------------------------------------------

/// Creates a `CADisplayLink` targeting `FerrumDisplayLinkTarget` and adds it
/// to the main run loop.
///
/// Must be called from the main thread (inside `applicationDidFinishLaunching`).
///
/// # Panics
///
/// Does not panic. Errors are logged and the display link setup is skipped
/// (non-fatal for Phase 0 — the runtime bootstrap is the critical path).
pub fn register_display_link() {
    let result = try_register_display_link();
    match result {
        Ok(()) => log::info!("ferrum-ios: CADisplayLink registered on main run loop"),
        Err(e) => log::warn!(
            "ferrum-ios: CADisplayLink registration failed (non-fatal for Phase 0): {e}"
        ),
    }
}

fn try_register_display_link() -> Result<(), String> {
    // Create the target object. Leak it to give it a static lifetime.
    // Phase 1: store in AppDelegate ivar and release on applicationWillTerminate.
    let target = FerrumDisplayLink::new();
    let target_ref: &'static FerrumDisplayLink = Box::leak(Box::new(target));

    // Create the CADisplayLink with target/selector.
    // Selector: displayLinkFired: (must match the method name in declare_class!)
    // SAFETY: target_ref is valid for the process lifetime (leaked above).
    //         sel!(displayLinkFired:) matches the registered ObjC method.
    //         displayLinkWithTarget:selector: is the designated factory method.
    let display_link: Retained<CADisplayLink> = unsafe {
        CADisplayLink::displayLinkWithTarget_selector(
            target_ref as &AnyObject,
            sel!(displayLinkFired:),
        )
    };

    // Add to the main run loop in NSRunLoopCommonModes so it fires during
    // scroll tracking as well as normal run loop cycles.
    // SAFETY: NSRunLoop::mainRunLoop is always valid; NSRunLoopCommonModes is
    // a valid mode string constant.
    unsafe {
        // NSRunLoop::mainRunLoop() is a safe class method in objc2-foundation 0.2.
        let main_run_loop = NSRunLoop::mainRunLoop();
        // NSRunLoopCommonModes is an `&'static NSString` (NSRunLoopMode alias).
        display_link.addToRunLoop_forMode(&main_run_loop, NSRunLoopCommonModes);
    }

    // Leak the display link so it continues firing.
    // Phase 1: store in AppDelegate ivar and call invalidate on termination.
    std::mem::forget(display_link);

    log::debug!("ferrum-ios: CADisplayLink added to main run loop");
    Ok(())
}
