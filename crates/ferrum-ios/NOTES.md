# ferrum-ios — Phase 0 Open Questions and Notes

## 1. `objc2-ui-kit` surface for `UIApplicationMain`

`UIApplicationMain` is a **plain C function** declared in `<UIKit/UIApplication.h>`, not an ObjC class method. `objc2-ui-kit` currently (v0.2) does not generate a wrapper for it. The options are:

- **Current approach (used here)**: declare `extern "C" fn UIApplicationMain(...)` manually inside an `#[link(name = "UIKit", kind = "framework")]` block. This is safe — the symbol is guaranteed present on iOS 2.0+.
- **Alternative**: Use `objc2`'s `msg_send!` to call `+[UIApplication applicationWithDelegate:]` and then manually drive `CFRunLoopRun()`. This avoids the C extern declaration but requires more boilerplate.
- **Bevy / wgpu approach**: Both game engines use the same `extern "C" fn UIApplicationMain` pattern with a Rust-defined app delegate class registered via `objc2`'s `define_class!`. This is the most battle-tested path.

**Conclusion**: The `extern "C"` declaration approach is the right answer for Phase 0. Track `objc2-ui-kit` for a future `UIApplicationMain` wrapper.

## 2. CADisplayLink thread safety from Rust

`CADisplayLink` is a `CoreFoundation`-backed timer added to a `CFRunLoop`. Key facts:

- **Must be created and added to a run loop on the same thread** where it should fire. We create it inside `applicationDidFinishLaunching`, which runs on the main thread — correct.
- **The selector fires on the main thread's run loop**. All Hermes JS evaluation triggered from the selector is therefore single-threaded by default.
- **`CADisplayLink.timestamp`** is a `CFTimeInterval` (f64 seconds since system boot). This is what Phase 1 should use to drive `requestAnimationFrame`.
- **Thread-safety of `FRAME_COUNTER`**: the counter is an `AtomicI64`, so cross-thread reads from background threads (e.g., benchmarks) are safe.
- **Invalidation**: Call `[displayLink invalidate]` before releasing the object. The `mem::forget` in Phase 0 means the display link is never invalidated — acceptable for a proof-of-concept, but Phase 1 must call `invalidate` in `applicationWillTerminate`.

**Conclusion**: The main-thread-only constraint is satisfied by our bootstrap sequence. No additional synchronization is needed for Phase 0.

## 3. Bundling the JS file into the iOS app binary/bundle

iOS apps cannot access arbitrary file-system paths. The JS bundle must be packaged inside the `.app` directory. Two approaches:

### Option A: Copy file resource (current approach)
Copy `bundle.js` into the `.app` directory as a plain file. Load it via `NSBundle.mainBundle.pathForResource:ofType:`. Simple and debuggable — you can swap the bundle by re-running `launch.sh` without recompiling.

**Limitation**: The file is not encrypted by App Store distribution. Acceptable for Phase 0 (internal testing only).

### Option B: Embed bytes in the binary (compile-time)
Use `include_bytes!("../../../js/test_bundle.js")` to bake the bundle into the `.a` at compile time. No runtime file I/O. Useful for truly minimal deployments.

**Limitation**: Changing the JS requires a full Rust recompile. Impractical during active JS development.

### Option C: Hermes bytecode (`.hbc`)
Compile the JS to Hermes bytecode first (`hermesc -emit-binary -out bundle.hbc bundle.js`), then bundle the `.hbc` file. Bytecode evaluation is ~40% faster than source parsing on device.

**TODO(Phase 0, task 1)**: once `hermes-abi-rs` exposes `HermesABIRuntime::evaluate_bytecode`, switch `bundle.js` → `bundle.hbc`.

**Current approach**: Option A (copy file) with a `// EXPECT:` stub for CI.

## 4. Hermes static library acquisition for iOS

Meta distributes precompiled Hermes static libraries as part of the React Native release artifacts. There are three acquisition paths:

### Path A: From the `react-native` npm package (easiest)
```sh
npm install react-native@0.74  # or latest
ls node_modules/react-native/sdks/hermes/build_apple/hermes/build_Release/API/hermes/
# → libhermes.a  (fat library: arm64 + x86_64 simulator slices)
```

Extract the arm64 device slice:
```sh
lipo libhermes.a -extract arm64 -output libhermes-arm64.a
export HERMES_LIB_DIR=$(pwd)
```

### Path B: Build Hermes from source (most control)
```sh
git clone https://github.com/facebook/hermes
cd hermes
# Cross-compile for iOS device
cmake -S . -B build_ios \
  -DCMAKE_TOOLCHAIN_FILE=cmake/Toolchains/iOS.cmake \
  -DCMAKE_OSX_ARCHITECTURES=arm64 \
  -DCMAKE_BUILD_TYPE=Release \
  -DHERMESVM_ALLOW_HUGE_PAGES=OFF  # required for iOS
cmake --build build_ios
export HERMES_LIB_DIR=build_ios/API/hermes
```

Note: The iOS CMake toolchain requires Xcode ≥ 14.

### Path C: Download from GitHub releases
The `react-native-community/hermes-engine` package publishes prebuilt `.tar.gz` artifacts per RN version:
```
https://github.com/facebook/hermes/releases
```
Look for `hermes-runtime-ios-*.tar.gz` — these contain `libhermes.xcframework`.

### Which library files are needed?
For `ferrum-ios` (Phase 0 stub — no real Hermes calls yet):
- `libhermes.a` — the main Hermes VM static library
- `libhermesvm.a` — may be a separate archive in some build configurations

For Phase 1 (actual C ABI calls):
- The `hermes_abi.h` header (in `API/hermes_abi/`)
- The `libhermes.a` and any `libhermes_executor.a` needed for bytecode eval

### Binary size estimate
- Hermes static library linked into iOS arm64: ~3-5 MB stripped (vs ~8 MB unstripped)
- Baseline Ferrum binary without Hermes: ~150 KB
- See Phase 0 task 6: benchmark binary size overhead

## 5. `objc2` version compatibility

This crate pins `objc2 = "0.5"`, `objc2-foundation = "0.2"`, `objc2-ui-kit = "0.2"`, and `objc2-quartz-core = "0.2"`. These version numbers should be verified against `crates.io` — the `0.2.x` series for `objc2-*` framework crates corresponds to the `objc2 0.5.x` release train.

Check for updates before the Phase 0 gate:
```sh
cargo update --dry-run
```

## 6. `define_class!` and `UIApplicationDelegate` protocol

`objc2 0.5` requires the protocol to be imported from `objc2-ui-kit`. The `unsafe impl UIApplicationDelegate for AppDelegate` block must match the protocol methods exactly — including parameter types like `Option<&NSDictionary>` for the launch options parameter (which UIKit may pass as nil).

If `objc2-ui-kit` does not yet expose all `UIApplicationDelegate` methods we need (e.g., `applicationWillTerminate:`), they can be added via `unsafe impl AppDelegate { ... }` with the raw selector string.

## 7. ~~Open question~~ RESOLVED: Hermes stable C ABI exposes JS global registration

**Resolved 2026-03-28.** See `/Users/kim/dev/ferrum/docs/hermes-abi-analysis.md` for the full API surface.

`hermes_abi.h` exposes `create_function_from_host_function` via a `HermesABIHostFunctionVTable`. The complete registration path for `rust_add` requires no JSI or C++:

```
1. Implement HermesABIHostFunctionVTable { call: rust_extern_c_fn, release: drop_fn }
2. create_function_from_host_function(name_propnameid, arity=2, &host_fn) → HermesABIFunction
3. get_global_object() → HermesABIObject (JS globalThis)
4. set_object_property_from_propnameid(global, "rust_add", fn_as_value) → done
```

The `call` function pointer receives `(self, runtime, this_arg, args_ptr, arg_count)` — maps directly to a Rust `extern "C"` fn. `hermes-abi-rs` wraps this in a trampoline that boxes a Rust closure and calls it safely.

**Implication for ferrum-ios**: `runtime.rs` stub swap-in is straightforward. Once `ferrum-core` wires up `FerumRuntime::new()` → `register_global_fn("rust_add", ...)`, the four lines in `bootstrap_ferrum_runtime()` replace the entire stub. No changes needed to the iOS bootstrap layer (`app_delegate.rs`, `display_link.rs`, `lib.rs`).

See also: `plans/` directory for architecture decisions.
