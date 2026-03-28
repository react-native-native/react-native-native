//! ferrum-android-ndk — Android NDK bootstrap for Project Ferrum.
//!
//! This crate is the pure-NDK counterpart to `ferrum-android`. Instead of
//! entering via a Kotlin `Activity` → JNI call, it uses Android's
//! `NativeActivity` support: the OS dlopen-s this `.so` and calls
//! `android_main` directly. No Java, no Kotlin, no JNI handshake.
//!
//! Architecture mirrors `ferrum-ios`:
//!
//! ```text
//! NativeActivity (OS)
//!   └─ android_main(AndroidApp)           ← this file
//!        ├─ init logging (android_logger)
//!        ├─ load bundle.js (AAssetManager NDK C API)
//!        ├─ FerumRuntime::new()            ← ferrum-core
//!        ├─ evaluate_bundle()
//!        ├─ AChoreographer frame callback  ← NDK C API (no JNI Choreographer)
//!        └─ event loop (AndroidApp::poll_events)
//! ```
//!
//! # Thread model
//!
//! `android_main` runs on its own thread (not the Android UI thread).
//! `android-activity` attaches a `Looper` to this thread before calling
//! `android_main`, which is required for `AChoreographer_getInstance`.
//!
//! Hermes evaluation happens before the event loop begins. A window is NOT
//! needed for Phase 0 evaluation — we evaluate immediately and only wait for
//! the window in the event loop if rendering is required later.

use std::ffi::CStr;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::time::Duration;

use android_activity::{AndroidApp, MainEvent, PollEvent};
use ferrum_core::bootstrap::FerumRuntime;

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

/// Monotonically incrementing frame counter, updated from the Choreographer
/// callback. Both the registration and the callbacks run on the `android_main`
/// thread (which owns the Looper), so there is no concurrent write.
/// Reads from other threads are tolerated via `Relaxed`.
static FRAME_COUNTER: AtomicI64 = AtomicI64::new(0);

/// Set to `true` after the first Choreographer callback fires.
static CHOREOGRAPHER_FIRED: AtomicBool = AtomicBool::new(false);

/// Raw `AChoreographer*` stored as `i64` for `const`-compatible atomic init.
///
/// On `aarch64-linux-android` a pointer is 64 bits, matching `i64`.
/// Written once before the event loop starts; read back in the callback.
/// Both operations happen on the same thread — there is no data race.
static CHOREOGRAPHER_PTR: AtomicI64 = AtomicI64::new(0);

// ---------------------------------------------------------------------------
// Entry point — NativeActivity calls this after dlopen
// ---------------------------------------------------------------------------

/// NativeActivity entry point.
///
/// Declared without `#[unsafe(no_mangle)]` because `android-activity`'s
/// `native-activity` feature provides the `ANativeActivity_onCreate` glue
/// internally and arranges for this symbol to be found by the OS. The crate
/// macro `android_activity::main!` handles the export when the
/// `native-activity` feature is active — but for simplicity we rely on the
/// `#[no_mangle]` export here, which `android-activity` documents as the
/// correct approach.
#[unsafe(no_mangle)]
fn android_main(app: AndroidApp) {
    init_logging();
    log::info!("ferrum-android-ndk: android_main entered");

    // Load bundle.js from APK assets via NDK AAssetManager.
    // This happens on the android_main thread, before the event loop.
    // No window is required for Hermes evaluation.
    let bundle_bytes = match load_bundle_from_assets(&app) {
        Ok(bytes) => {
            log::info!(
                "ferrum-android-ndk: loaded bundle.js ({} bytes)",
                bytes.len()
            );
            bytes
        }
        Err(e) => {
            log::error!("ferrum-android-ndk: failed to load bundle.js: {e}");
            run_event_loop(app);
            return;
        }
    };

    // Bootstrap Hermes and evaluate the JS bundle.
    match bootstrap_and_eval(&bundle_bytes) {
        Ok(result) => {
            log::info!("ferrum-android-ndk: JS evaluation result: {result}");
        }
        Err(e) => {
            log::error!("ferrum-android-ndk: runtime error: {e}");
        }
    }

    // Register AChoreographer vsync callback via NDK C API.
    // `android-activity` attaches a Looper to this thread before calling
    // `android_main`, which is the precondition for `AChoreographer_getInstance`.
    register_choreographer_callback();

    // Drive the NativeActivity lifecycle.
    run_event_loop(app);
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

fn init_logging() {
    android_logger::init_once(
        android_logger::Config::default()
            .with_max_level(log::LevelFilter::Trace)
            .with_tag("ferrum-ndk"),
    );
}

// ---------------------------------------------------------------------------
// Asset loading — AAssetManager NDK C API via ndk crate safe wrappers
// ---------------------------------------------------------------------------

/// Load `bundle.js` from the APK's `assets/` directory.
///
/// Uses [`ndk::asset::AssetManager`], which wraps `AAssetManager_open` /
/// `AAsset_getBuffer`. No JNI is involved.
fn load_bundle_from_assets(app: &AndroidApp) -> Result<Vec<u8>, String> {
    // `AndroidApp::asset_manager()` returns an `ndk::asset::AssetManager`
    // wrapping the `AAssetManager*` that NativeActivity provides.
    let mgr = app.asset_manager();

    // SAFETY: The CStr literal is correct — no interior NUL bytes, and it is
    // terminated. `AssetManager::open` calls `AAssetManager_open` internally
    // and returns `None` if the file does not exist.
    let mut asset = mgr
        .open(
            // SAFETY: "bundle.js\0" has exactly one NUL at the end.
            unsafe { CStr::from_bytes_with_nul_unchecked(b"bundle.js\0") },
        )
        .ok_or_else(|| {
            "AAssetManager_open returned NULL for 'bundle.js' \
             (check that assets/bundle.js is in the APK)"
                .to_string()
        })?;

    // `Asset::buffer()` calls `AAsset_getBuffer`, mapping the asset into
    // memory and returning a slice. We copy to `Vec` so the bytes outlive
    // the `asset` (whose drop calls `AAsset_close`).
    let bytes = asset
        .buffer()
        .map_err(|e| format!("AAsset_getBuffer failed: {e}"))?
        .to_vec();

    // `asset` drops here → `AAsset_close` via ndk's Drop impl.
    Ok(bytes)
}

// ---------------------------------------------------------------------------
// Ferrum runtime bootstrap
// ---------------------------------------------------------------------------

/// Create a [`FerumRuntime`], evaluate the JS bundle, and intentionally leak
/// the runtime handle.
///
/// Leaking mirrors the iOS approach (`ferrum-ios/src/runtime.rs`). In Phase 0
/// the process exits when NativeActivity finishes. Phase 1 will store the
/// runtime in a proper owner with explicit lifetime management.
fn bootstrap_and_eval(bundle_bytes: &[u8]) -> Result<String, String> {
    log::info!("ferrum-android-ndk: creating Hermes runtime via ferrum-core...");

    let rt = FerumRuntime::new().map_err(|e| format!("FerumRuntime::new: {e}"))?;

    log::info!("ferrum-android-ndk: Hermes runtime created, rust_add registered");

    // Sanity-check: evaluate a trivial expression.
    match rt.hermes().evaluate_js(b"1 + 1;", "<sanity>") {
        Ok(v) => {
            let n = v.as_number().unwrap_or(f64::NAN);
            log::info!("ferrum-android-ndk: sanity eval '1+1' = {n}");
        }
        Err(e) => {
            return Err(format!("sanity eval failed: {e}"));
        }
    }

    // Verify that `rust_add` is reachable from JS.
    match rt
        .hermes()
        .evaluate_js(b"rust_add(40, 2);", "<test-rust-add>")
    {
        Ok(v) => {
            let n = v.as_number().unwrap_or(f64::NAN);
            log::info!("ferrum-android-ndk: rust_add(40, 2) = {n}");
        }
        Err(e) => {
            return Err(format!("rust_add eval failed: {e}"));
        }
    }

    // Evaluate the real bundle.
    let result = rt
        .evaluate_bundle(bundle_bytes, "bundle.js")
        .map_err(|e| format!("evaluate_bundle: {e}"))?;

    let result_str = if let Some(n) = result.as_number() {
        format!("{n}")
    } else {
        "non-numeric result".to_string()
    };

    // Intentional leak — see doc comment above.
    std::mem::forget(rt);

    Ok(result_str)
}

// ---------------------------------------------------------------------------
// AChoreographer vsync frame callback — NDK C API, zero JNI
// ---------------------------------------------------------------------------

/// Register a vsync frame callback using `AChoreographer` (NDK API ≥ 24).
///
/// This is the pure-NDK alternative to `android.view.Choreographer` (which
/// requires JNI). The callback fires on the `android_main` Looper thread.
fn register_choreographer_callback() {
    // SAFETY: `AChoreographer_getInstance` is safe to call on any thread that
    // has a Looper attached. `android-activity` guarantees a Looper is
    // attached to the `android_main` thread before `android_main` is invoked.
    // The returned pointer is valid for the lifetime of the Looper (i.e. the
    // lifetime of the `android_main` thread).
    let choreographer = unsafe { ndk_sys::AChoreographer_getInstance() };

    if choreographer.is_null() {
        log::warn!(
            "ferrum-android-ndk: AChoreographer_getInstance() returned NULL \
             (API level < 24, or no Looper on this thread) — vsync disabled"
        );
        return;
    }

    // Store as i64 for portable atomic access (pointer == i64 on aarch64).
    CHOREOGRAPHER_PTR.store(choreographer as i64, Ordering::Release);

    post_frame_callback(choreographer);

    log::info!("ferrum-android-ndk: AChoreographer_postFrameCallback registered");
}

/// Submit a one-shot vsync callback to `choreographer`.
///
/// Called once at startup and then re-posted from within `on_frame_callback`
/// so we receive continuous vsync notifications.
fn post_frame_callback(choreographer: *mut ndk_sys::AChoreographer) {
    // SAFETY:
    // - `choreographer` is a valid non-null pointer obtained from
    //   `AChoreographer_getInstance`.
    // - `on_frame_callback` has exactly the signature required by
    //   `AChoreographer_frameCallback` (= `unsafe extern "C" fn(c_long, *mut c_void)`).
    // - The data pointer is null — the callback reads global atomics only.
    unsafe {
        ndk_sys::AChoreographer_postFrameCallback(
            choreographer,
            Some(on_frame_callback),
            std::ptr::null_mut(),
        );
    }
}

/// Vsync frame callback invoked by `AChoreographer` on each display refresh.
///
/// The NDK type alias is:
/// ```c
/// void (*AChoreographer_frameCallback)(long frameTimeNanos, void *data);
/// ```
/// On `aarch64` `long == i64`, matching `std::os::raw::c_long`.
///
/// # Safety
/// Called by the Android runtime on the NativeActivity Looper thread.
/// `frame_time_nanos` is the vsync timestamp in nanoseconds (CLOCK_MONOTONIC).
unsafe extern "C" fn on_frame_callback(
    frame_time_nanos: std::os::raw::c_long,
    _data: *mut std::ffi::c_void,
) {
    let count = FRAME_COUNTER.fetch_add(1, Ordering::Relaxed) + 1;
    CHOREOGRAPHER_FIRED.store(true, Ordering::Relaxed);

    if count % 60 == 0 {
        log::debug!(
            "ferrum-android-ndk: frame {count}, vsync_ns={frame_time_nanos}"
        );
    }

    // Re-post for the next frame. Choreographer callbacks are one-shot.
    //
    // SAFETY: `CHOREOGRAPHER_PTR` was written by `register_choreographer_callback`
    // before the first callback fired, and is never modified again. Both
    // the initial write and all callback re-posts happen on the same Looper
    // thread, so there is no data race on the choreographer itself.
    let ptr = CHOREOGRAPHER_PTR.load(Ordering::Acquire) as *mut ndk_sys::AChoreographer;
    if !ptr.is_null() {
        unsafe {
            ndk_sys::AChoreographer_postFrameCallback(
                ptr,
                Some(on_frame_callback),
                std::ptr::null_mut(),
            );
        }
    }
}

// ---------------------------------------------------------------------------
// NativeActivity event loop
// ---------------------------------------------------------------------------

/// Drive the `NativeActivity` lifecycle until the OS sends `Destroy`.
///
/// `AndroidApp::poll_events` must be called regularly so the OS can deliver
/// `MainEvent::Destroy` and other lifecycle callbacks. Without polling the
/// activity would be killed for ANR.
fn run_event_loop(app: AndroidApp) {
    log::info!("ferrum-android-ndk: entering event loop");

    let mut running = true;
    while running {
        app.poll_events(
            // ~16 ms timeout keeps us responsive between vsync callbacks.
            Some(Duration::from_millis(16)),
            |event| {
                match event {
                    PollEvent::Wake => {}
                    PollEvent::Timeout => {}
                    PollEvent::Main(main_event) => {
                        if !handle_main_event(main_event) {
                            running = false;
                        }
                    }
                    // `PollEvent` is `#[non_exhaustive]` — ignore future variants.
                    _ => {}
                }
            },
        );
    }

    log::info!("ferrum-android-ndk: event loop exited");
}

/// Handle a single [`MainEvent`].
///
/// Returns `false` when the activity should stop looping (`Destroy`).
fn handle_main_event(event: MainEvent<'_>) -> bool {
    match event {
        MainEvent::InitWindow { .. } => {
            log::info!("ferrum-android-ndk: window initialized");
        }
        MainEvent::TerminateWindow { .. } => {
            log::info!("ferrum-android-ndk: window terminated");
        }
        MainEvent::WindowResized { .. } => {
            log::debug!("ferrum-android-ndk: window resized");
        }
        MainEvent::RedrawNeeded { .. } => {
            log::debug!("ferrum-android-ndk: redraw needed");
        }
        MainEvent::ContentRectChanged { .. } => {
            log::debug!("ferrum-android-ndk: content rect changed");
        }
        MainEvent::GainedFocus => {
            log::debug!("ferrum-android-ndk: gained focus");
        }
        MainEvent::LostFocus => {
            log::debug!("ferrum-android-ndk: lost focus");
        }
        MainEvent::ConfigChanged { .. } => {
            log::debug!("ferrum-android-ndk: config changed");
        }
        MainEvent::LowMemory => {
            log::warn!("ferrum-android-ndk: low memory warning");
        }
        MainEvent::Start => {
            log::info!("ferrum-android-ndk: activity started");
        }
        MainEvent::Resume { loader: _, .. } => {
            log::info!(
                "ferrum-android-ndk: activity resumed ({} frames so far)",
                FRAME_COUNTER.load(Ordering::Relaxed)
            );
        }
        MainEvent::SaveState { saver: _, .. } => {
            // Phase 0 has no state to save.
        }
        MainEvent::Pause => {
            log::info!("ferrum-android-ndk: activity paused");
        }
        MainEvent::Stop => {
            log::info!("ferrum-android-ndk: activity stopped");
        }
        MainEvent::Destroy => {
            log::info!("ferrum-android-ndk: received Destroy — stopping event loop");
            return false;
        }
        MainEvent::InsetsChanged { .. } => {
            log::debug!("ferrum-android-ndk: insets changed");
        }
        MainEvent::InputAvailable => {}
        // `MainEvent` is `#[non_exhaustive]` — tolerate future variants.
        _ => {}
    }
    true
}
