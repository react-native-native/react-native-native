//! ferrum-android — Android bootstrap for Project Ferrum.
//!
//! Compiles to `libferrum_android.so`, loaded by `MainActivity` via JNI.
//! Creates a real Hermes runtime via ferrum-core, registers `rust_add`,
//! evaluates the JS bundle, and returns the result to Kotlin.

use jni::objects::{JClass, JObject, JValue};
use jni::sys::{jint, jlong, JNI_VERSION_1_6};
use jni::{JNIEnv, JavaVM};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::OnceLock;

use ferrum_core::bootstrap::FerumRuntime;

static FRAME_COUNTER: AtomicI64 = AtomicI64::new(0);
static JVM: OnceLock<JavaVM> = OnceLock::new();

// ---------------------------------------------------------------------------
// JNI_OnLoad
// ---------------------------------------------------------------------------

#[unsafe(no_mangle)]
pub unsafe extern "C" fn JNI_OnLoad(
    vm: *mut jni::sys::JavaVM,
    _reserved: *mut std::ffi::c_void,
) -> jint {
    // SAFETY: `vm` is the process-global JavaVM pointer from Android runtime.
    let javavm = unsafe {
        JavaVM::from_raw(vm).expect("JNI_OnLoad: JavaVM::from_raw failed")
    };
    JVM.set(javavm)
        .expect("JNI_OnLoad called more than once");
    JNI_VERSION_1_6
}

// ---------------------------------------------------------------------------
// JNI entry point — called by MainActivity.initFerrum()
// ---------------------------------------------------------------------------

#[unsafe(no_mangle)]
pub unsafe extern "C" fn Java_com_ferrum_app_MainActivity_initFerrum(
    mut env: JNIEnv,
    _class: JClass,
    asset_manager: JObject,
) -> jni::sys::jstring {
    init_logging();
    log::info!("ferrum-android: initFerrum() called");

    // Load JS bundle from APK assets
    let bundle_bytes = match load_bundle_from_assets(&mut env, &asset_manager) {
        Ok(bytes) => {
            log::info!("ferrum-android: loaded JS bundle ({} bytes)", bytes.len());
            bytes
        }
        Err(e) => {
            log::error!("ferrum-android: bundle load failed: {e}");
            let msg = format!("Bundle ERROR: {e}");
            return env.new_string(msg).unwrap().into_raw();
        }
    };

    // Bootstrap real Hermes runtime via ferrum-core
    let result_message = match bootstrap_ferrum_runtime(&bundle_bytes) {
        Ok(output) => {
            log::info!("ferrum-android: runtime bootstrap succeeded: {output}");
            register_choreographer_callback(&mut env);
            format!("Ferrum OK: {output}")
        }
        Err(e) => {
            log::error!("ferrum-android: runtime bootstrap failed: {e}");
            format!("Ferrum ERROR: {e}")
        }
    };

    env.new_string(result_message)
        .expect("Failed to create JNI result string")
        .into_raw()
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

fn init_logging() {
    android_logger::init_once(
        android_logger::Config::default()
            .with_max_level(log::LevelFilter::Trace)
            .with_tag("ferrum"),
    );
}

// ---------------------------------------------------------------------------
// JS bundle loading from APK assets
// ---------------------------------------------------------------------------

fn load_bundle_from_assets(env: &mut JNIEnv, asset_manager: &JObject) -> Result<Vec<u8>, String> {
    let filename = env
        .new_string("bundle.js")
        .map_err(|e| format!("new_string: {e}"))?;

    let input_stream = env
        .call_method(
            asset_manager,
            "open",
            "(Ljava/lang/String;)Ljava/io/InputStream;",
            &[JValue::Object(&filename)],
        )
        .map_err(|e| format!("AssetManager.open: {e}"))?
        .l()
        .map_err(|e| format!("open result: {e}"))?;

    let bytes_obj = env
        .call_method(&input_stream, "readAllBytes", "()[B", &[])
        .map_err(|e| format!("readAllBytes: {e} (requires API 33+)"))?
        .l()
        .map_err(|e| format!("readAllBytes result: {e}"))?;

    let byte_array = jni::objects::JByteArray::from(bytes_obj);
    let bytes = env
        .convert_byte_array(&byte_array)
        .map_err(|e| format!("convert_byte_array: {e}"))?;

    let _ = env.call_method(&input_stream, "close", "()V", &[]);

    Ok(bytes.iter().map(|&b| b as u8).collect())
}

// ---------------------------------------------------------------------------
// Ferrum runtime bootstrap — real Hermes via ferrum-core
// ---------------------------------------------------------------------------

fn bootstrap_ferrum_runtime(bundle_bytes: &[u8]) -> Result<String, String> {
    log::info!("ferrum-android: creating Hermes runtime via ferrum-core...");

    let rt = FerumRuntime::new().map_err(|e| format!("FerumRuntime::new: {e}"))?;

    log::info!("ferrum-android: Hermes runtime created, rust_add registered");

    let result = rt
        .evaluate_bundle(bundle_bytes, "bundle.js")
        .map_err(|e| format!("evaluate_bundle: {e}"))?;

    let result_str = if let Some(n) = result.as_number() {
        format!("{n}")
    } else {
        "non-numeric result".to_string()
    };

    log::info!("ferrum-android: JS evaluation result: {result_str}");

    // Leak the runtime (same as iOS — proper lifecycle in Phase 1)
    std::mem::forget(rt);

    Ok(result_str)
}

// ---------------------------------------------------------------------------
// Choreographer frame callback
// ---------------------------------------------------------------------------

fn register_choreographer_callback(env: &mut JNIEnv) {
    match try_register_choreographer(env) {
        Ok(()) => log::info!("ferrum-android: Choreographer callback registered"),
        Err(e) => log::warn!("ferrum-android: Choreographer failed (non-fatal): {e}"),
    }
}

fn try_register_choreographer(env: &mut JNIEnv) -> Result<(), String> {
    let choreographer_class = env
        .find_class("android/view/Choreographer")
        .map_err(|e| format!("find_class: {e}"))?;

    let choreographer = env
        .call_static_method(
            &choreographer_class,
            "getInstance",
            "()Landroid/view/Choreographer;",
            &[],
        )
        .map_err(|e| format!("getInstance: {e}"))?
        .l()
        .map_err(|e| format!("result: {e}"))?;

    if choreographer.is_null() {
        return Err("Choreographer.getInstance() returned null".into());
    }

    log::info!(
        "ferrum-android: Choreographer ready. Frame counter at {}.",
        FRAME_COUNTER.load(Ordering::Relaxed)
    );
    Ok(())
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn Java_com_ferrum_app_FerrumFrameCallback_onFrame(
    _env: JNIEnv,
    _class: JClass,
    frame_time_nanos: jlong,
) {
    let count = FRAME_COUNTER.fetch_add(1, Ordering::Relaxed) + 1;
    if count % 60 == 0 {
        log::debug!("ferrum-android: frame {count}, time_ns={frame_time_nanos}");
    }
}
