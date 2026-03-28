# ferrum-android — Phase 0 Open Questions

Engineering notes for the Android bootstrap binary. These are the questions
Phase 0 must answer before Phase 1 begins.

---

## 1. NativeActivity vs Java Activity: trade-offs for Ferrum

### NativeActivity

`android.app.NativeActivity` (API 9+) allows the process entry point to be
a C/Rust `android_main` function. No Java class is required beyond the manifest
declaration `android:hasCode="false"`. The `android-activity` crate provides
an ergonomic Rust wrapper.

**Advantages for Ferrum:**
- Rust owns `main`. No thin Java layer.
- Choreographer, input, and window surface all arrive via `AInputQueue`,
  `ALooper`, and `ANativeWindow` — C structs, no JNI needed for the hot path.
- Aligns with the game engine model (Unity, Unreal, Bevy all use NativeActivity
  or the equivalent).

**Disadvantages for Ferrum:**
- `android:hasCode="false"` prevents adding any Java/Kotlin code to the APK
  without a separate module — complicates adding Choreographer via Java if the
  NDK API proves insufficient.
- `NativeActivity` does not expose `AssetManager` directly without JNI.
  `AAssetManager_fromJava` requires the Java `AssetManager` handle.
- Some Android subsystems have no NDK equivalent and require JNI regardless
  (Bluetooth, some sensor APIs, system dialogs).
- Debugger tooling (Android Studio profiler) has worse support for
  NativeActivity-based apps.

### Thin Java Activity (current Phase 0 choice)

A minimal Kotlin `Activity` that calls `System.loadLibrary` and one JNI method.
Rust receives a `JNIEnv` and can call any Java API via JNI.

**Advantages:**
- Works with all API levels.
- Easy to add Java APIs later without restructuring.
- Android Studio Profiler, memory analysis tools work normally.
- Choreographer via Java is straightforward (see §2).

**Disadvantages:**
- One layer of indirection: Rust ↔ JNI ↔ Java.
- Does not satisfy the "Rust owns `main`" ideal from the architecture doc.

### Recommendation for Ferrum

**Phase 0**: Thin Java Activity. Lower risk, faster iteration, no build system
complexity.

**Phase 1**: Evaluate `android-activity` crate's NativeActivity backend.
The key question (CLAUDE.md §Open Questions #5) is whether Fabric's
`Activity` lifecycle assumptions are satisfied. If Fabric calls
`Activity.runOnUiThread` or checks `Activity` state, NativeActivity will
break it. Audit Fabric's Android C++ layer before committing.

**Hybrid approach (likely final answer)**: Keep a thin Kotlin `Activity` as
the process entry point but move all Ferrum logic to a Rust-owned thread.
The Activity serves only to satisfy Android lifecycle requirements and load
the library. Rust calls back to main thread via `Handler(Looper.getMainLooper())`
for UI operations.

---

## 2. Choreographer JNI threading considerations

`Choreographer.getInstance()` is a thread-local singleton that requires
`Looper.myLooper() != null`. This is satisfied on the main thread automatically
and on any thread that has called `Looper.prepare()`.

**Threading model for Phase 1:**

```
Main Thread (Looper attached)
  │
  ├── Activity.onCreate() → System.loadLibrary() → initFerrum() [JNI]
  │     └── Rust: init logging, create FerumRuntime, register rust_add
  │     └── Rust: FerrumFrameCallback.start() [posts to Choreographer]
  │
  └── FerrumFrameCallback.doFrame(frameTimeNanos) [vsync callback]
        └── JNI: Java_com_ferrum_app_FerrumFrameCallback_onFrame [Rust]
              └── Rust: ferrum_core::tick(frame_time_nanos)
                    ├── Hermes requestAnimationFrame callbacks
                    └── Fabric shadow tree commit (must be on main thread)
```

**Key constraint**: The Choreographer callback fires on the thread that called
`postFrameCallback`. For Ferrum, that must be the main thread. All Hermes
and Fabric work triggered from the callback is therefore main-thread-safe.

**Background Hermes evaluation**: If Hermes evaluation is moved to a
background thread for performance (avoiding main thread jank), the thread
must not access Fabric or Choreographer. Only `requestAnimationFrame` delivery
must happen on the main thread. Design the `ferrum_core::tick` split carefully.

**Choreographer callback leak**: If `FerrumFrameCallback.start()` is called
multiple times (e.g., Activity restart), multiple frame loops will be posted.
Guard with the `instance` singleton in `FerrumFrameCallback.kt` (already done).

---

## 3. Bundling JS files into APK assets

**Phase 0 approach**: `assets/bundle.js` is a plain JS file in
`android/app/src/main/assets/`. Gradle includes all files in `assets/`
in the APK automatically. Rust reads it via `AssetManager.open("bundle.js")`.

**Phase 0 limitation**: `AssetManager.readAllBytes()` requires API 33
(Android 13). For API 26–32 compatibility, replace with a manual byte read
loop using `InputStream.read(byte[], int, int)`. The TODO is marked in
`src/lib.rs`.

**Phase 1 options** (order of preference):

1. **Hermes bytecode** (`.hbc`): Pre-compile `bundle.js` with `hermesc`
   to Hermes bytecode. Bytecode evaluates faster (no parse step) and is
   smaller. Store as `assets/bundle.hbc`. Rust passes bytes directly to
   `HermesABIRuntime::evaluateBytecode()`.

2. **Metro dev server**: For development, Rust fetches the bundle from
   `http://localhost:8081/index.bundle` via an HTTP client (e.g., `ureq`).
   Requires `android.permission.INTERNET` in the manifest.

3. **Packaged asset with lazy decompression**: For release, bundle multiple
   JS files into a single compressed archive in `assets/`. Rust decompresses
   on first launch and caches to internal storage. Avoids the 100MB APK asset
   limit for large apps.

**Asset path convention** (proposed):
```
assets/
  bundle.hbc          # Release: Hermes bytecode
  bundle.js           # Debug only: source for stack traces
  bundle.map          # Debug only: source map
```

---

## 4. Hermes shared library acquisition for Android

Meta distributes precompiled `libhermes.so` for Android through several channels:

### Option A: npm package (recommended for Phase 0)

```sh
npm install react-native@0.84
# libhermes.so is at:
# node_modules/react-native/android/app/src/main/jni/first-party/hermes/lib/arm64-v8a/libhermes.so
```

This is the fastest path for Phase 0. The `.so` is prebuilt for
`aarch64-linux-android` with API 26 minimum.

### Option B: Maven AAR

```groovy
// In app/build.gradle, add:
implementation("com.facebook.react:hermes-android:0.84.0")
```

Gradle extracts the `.so` from the AAR automatically. However, this requires
wiring Hermes as an Android dependency rather than a Rust dependency.

For Ferrum's architecture (Rust links Hermes directly), extract the `.so` from
the AAR manually:
```sh
unzip ~/.gradle/caches/.../hermes-android-0.84.0.aar -d /tmp/hermes-aar
# .so is at: /tmp/hermes-aar/jni/arm64-v8a/libhermes.so
```

### Option C: Build from source

```sh
git clone https://github.com/facebook/hermes
cd hermes
python utils/build/build_apple.py  # iOS
# For Android: use the build_hermes_android.sh script
./utils/build/build_hermes_android.sh -e /path/to/ndk -t arm64-v8a
```

Building from source ensures the `.so` matches the `hermes_abi.h` version
used by `hermes-abi-rs`. Required once `hermes-abi-rs` targets a specific
Hermes commit.

### Deployment consideration

`libhermes.so` must ship inside the APK in `jniLibs/arm64-v8a/`. At runtime,
the Android class loader loads `libferrum_android.so` which `dlopen`s `libhermes.so`
(if dynamically linked). Both `.so` files must be in the same directory.

Alternative: statically link Hermes into `libferrum_android.so`. This simplifies
deployment (one `.so`) at the cost of binary size (~15MB for Hermes static lib).
Evaluate in Phase 0 benchmarks (CLAUDE.md §Open Questions #6).

---

## 5. Can a Rust-owned process satisfy Activity lifecycle requirements?

This is CLAUDE.md Phase 0 Open Question #5. Current understanding:

**What Fabric actually needs** (to be audited in Phase 1 Step 1.2):

The Fabric C++ layer (`react-native/ReactCommon/react/renderer/`) does not
directly reference Java's `Activity`. It communicates with the Android platform
through:

1. **`ReactContext`** — wraps a Java `Context`. Used for theme, resource, and
   intent operations. `Ferrum` would pass the `Activity` context here.

2. **`UIManagerModule` / `FabricUIManager`** — invokes `Activity.runOnUiThread`
   for main-thread view operations. Equivalent Rust approach: post to main
   `Looper` via `Handler`.

3. **`SurfaceManager`** — uses `Activity` for `FragmentManager` operations.
   This is the highest-risk coupling.

**Hypothesis**: Fabric's core rendering (shadow tree, layout, commit) does not
require a live `Activity`. Only view mounting touches Android's `Activity` APIs.
If correct, Rust can own the process and satisfy the minimal lifecycle by:
- Keeping the Kotlin `Activity` alive (do not call `finish()`)
- Delegating main-thread UI operations to the Activity via JNI callbacks

**Risk**: If `FragmentManager` or `AppCompatActivity` features are required by
Fabric, the thin Java Activity approach may need to become a `FragmentActivity`.
This is acceptable — it does not change the Rust ownership model.

**Phase 1 action**: Audit `FabricUIManager.cpp` and `SurfaceManager.cpp` for
Java API calls. Map each call to its Rust/JNI equivalent. Document in a
Phase 1 dependency audit.

---

## 6. Binary size estimates

Rough estimates for `aarch64-linux-android`, release build with LTO:

| Component | Size estimate |
|---|---|
| `libferrum_android.so` (no Hermes, no ferrum-core) | ~50–100 KB |
| `libferrum_android.so` (with ferrum-core stubs) | ~200–500 KB |
| `libhermes.so` (dynamic, from npm RN 0.84) | ~12–15 MB |
| `libferrum_android.so` (Hermes statically linked) | ~13–16 MB |
| Standard React Native APK (reference) | ~25–35 MB |

**Phase 0 measurement target**: Record actual sizes after first successful
device boot. Compare dynamic vs static Hermes linking. Document in the
benchmark report (CLAUDE.md Phase 0 task 6).

---

_Last updated: 2026-03-28_
