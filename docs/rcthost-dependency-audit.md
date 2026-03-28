# RCTHost / ReactInstance Dependency Audit

> Phase 0 research for Project Ferrum — 2026-03-28

## Executive Summary

RCTHost (iOS) and ReactHost (Android) are the top-level orchestrators for React Native applications. They assemble ~12 subsystems to boot a JS runtime and render UI. For Ferrum Phase 0, **only 3 of these are required** (JS runtime, message thread, error handler). The remaining subsystems are needed for Fabric rendering and module loading — relevant to later phases but not to Phase 0's "boot and call Rust from JS" goal.

Key finding: **RCTHost has no hard dependency on UIApplication run loop** for JS evaluation. The Fabric shadow tree and surface presenter depend on main-thread dispatch but not on UIApplication lifecycle callbacks.

## iOS: RCTHost → RCTInstance Initialization Flow

### RCTHost Responsibilities (Outer Shell)

RCTHost (`RCTHost.h`) is the public API that app developers interact with. It:

1. Holds a delegate that provides bundle URL and module configuration
2. Creates and owns an `RCTInstance`
3. Manages surface lifecycle (start/stop surfaces for specific React components)
4. Handles reload requests (recreate RCTInstance without destroying RCTHost)
5. Provides `RCTSurfacePresenter` to the app for Fabric rendering

### RCTInstance Initialization Sequence (Inner Core)

`RCTInstance.mm` performs the actual initialization in this order:

| Step | Component | Purpose | Thread |
|------|-----------|---------|--------|
| 1 | `RCTPerformanceLogger` | Timing instrumentation | Any |
| 2 | `RCTJSThreadManager` | Creates dedicated JS thread + message queue | Creates thread |
| 3 | `RCTBridgeModuleDecorator` | Legacy module/view registry adapter | Any |
| 4 | `ObjCTimerRegistry` → `TimerManager` | setTimeout/setInterval/requestAnimationFrame | JS thread |
| 5 | `JSRuntime` (via factory) | Hermes runtime instance | JS thread |
| 6 | `ReactInstance` (C++) | Core runtime with executors and schedulers | JS thread |
| 7 | `RCTBridgeProxy` | Legacy bridge compatibility shim | Main thread |
| 8 | `RuntimeSchedulerCallInvoker` | Schedule native → JS calls | Any |
| 9 | `RCTTurboModuleManager` | Lazy-loaded native module registry | Main thread (some) |
| 10 | Context container | Shared state: image loader, event dispatcher, etc. | Any |
| 11 | `RCTSurfacePresenter` | Fabric renderer connection | Main thread |
| 12 | `RCTDisplayLink` | CADisplayLink-based frame callbacks | Main thread |
| 13 | `initializeRuntime` | Install JS globals, turbo module bindings | JS thread |
| 14 | Bundle loading | Load and evaluate JS bundle | JS thread |

### ReactInstance (C++) Core Requirements

The platform-independent `ReactInstance` constructor requires only:

```cpp
ReactInstance(
    std::unique_ptr<JSRuntime> runtime,              // Required
    std::shared_ptr<MessageQueueThread> jsThread,    // Required
    std::shared_ptr<TimerManager> timerManager,      // Required
    JsErrorHandler::OnJsError onJsError,             // Required
    jsinspector_modern::HostTarget *inspectorTarget  // Optional
);
```

During `initializeRuntime`, it installs these JS globals:
- `RN$Bridgeless` — boolean flag (always `true` in new arch)
- `RN$DiagnosticFlags` — profiling configuration
- `RN$isRuntimeReady` — readiness check function
- `RN$handleException` — error handler callback
- Timer globals via `TimerManager` (setTimeout, etc.)

## Dependency Classification for Ferrum

### REQUIRED (Must Replicate for Phase 0)

| Component | Why | Ferrum Equivalent |
|-----------|-----|-------------------|
| JS Runtime (Hermes) | Evaluates JavaScript | Direct C ABI embedding |
| JS Thread / Message Queue | Serializes JS execution | Rust `std::thread` + channel |
| Error Handler | Catch JS/native exceptions | Rust `Result` + logging |

### REQUIRED (Must Replicate for Fabric — Phase 1+)

| Component | Why | Ferrum Equivalent |
|-----------|-----|-------------------|
| `TimerManager` | setTimeout/setInterval/rAF | Rust timer wheel or platform timer |
| `SurfacePresenter` | Connects shadow tree to native views | `FerumFabric` (custom) |
| Display Link | Frame-synchronized callbacks | `CADisplayLink` via objc2 (iOS), Choreographer via JNI (Android) |
| `RuntimeScheduler` | Prioritized JS task scheduling | Rust async runtime or custom scheduler |
| Context Container | Shared state between subsystems | Rust `Arc<AppContext>` |

### OPTIONAL (Nice to Have)

| Component | Why | Notes |
|-----------|-----|-------|
| `TurboModuleManager` | Lazy module loading | Ferrum uses plain function pointers instead |
| `BridgeProxy` | Legacy bridge compat | Not needed — Ferrum is bridgeless by design |
| Performance Logger | Instrumentation | Can add later for benchmarking |
| Inspector Target | Chrome DevTools | Nice for dev, not required |

### REMOVABLE (Not Needed for Ferrum)

| Component | Why Not |
|-----------|---------|
| `RCTBridgeModuleDecorator` | Legacy bridge concept — Ferrum has no bridge |
| `RCTDevMenuConfigurationDecorator` | Dev menu UI — not applicable |
| `RCTBundleManager` | RN bundle URL management — Ferrum loads bundles directly |
| Memory warning notification subscription | iOS-specific optimization — handle separately |
| Callable module invoker | RN-specific JS ↔ native module pattern |

## Answers to Open Questions

### Question #2: Can Fabric shadow tree init without UIApplication run loop?

**Yes, with caveats.**

The Fabric shadow tree is pure C++ — `ShadowTree`, `ShadowNode`, and the diffing/flattening algorithms have no dependency on UIApplication, UIKit, or any iOS framework. The shadow tree is an immutable data structure created from React element descriptions.

What DOES require main thread (but NOT UIApplication run loop):
- **View mounting**: Creating and mutating `UIView` instances must happen on the main thread
- **`RCTSurfacePresenter`**: Dispatches mount operations to main thread via GCD
- **`RCTDisplayLink`**: Wraps `CADisplayLink` which requires a run loop

For Ferrum, the key insight is:
- Shadow tree creation and diffing: **works from any thread, no run loop needed**
- View mounting: **requires main thread dispatch** but can use `dispatch_async(dispatch_get_main_queue(), ...)` from Rust via objc2 — this works even without UIApplication if you manually run the main run loop (`CFRunLoopRun()`)
- Frame scheduling: **requires a run loop** but can use `CFRunLoop` directly, which `CADisplayLink` attaches to — no `UIApplication` dependency

**Verdict**: Fabric shadow tree initialization works without UIApplication. View mounting and frame scheduling need a run loop on the main thread, which Rust can create and own directly via Core Foundation APIs.

### Question #3: Minimum set of RCTHost initialisers for AppRegistry.runApplication?

For `AppRegistry.runApplication()` to succeed, you need:

1. **Hermes runtime** — to evaluate JS
2. **JS thread with message queue** — ReactInstance requires this
3. **TimerManager** — `AppRegistry` internally uses `setTimeout`
4. **RuntimeScheduler** — schedules batched UI updates
5. **SurfacePresenter** — provides the Fabric renderer that `AppRegistry` renders into
6. **TurboModule bindings** — `AppRegistry` calls into native modules (at minimum `UIManager`)
7. **Bundle loaded and evaluated** — the React app code must be loaded

Items NOT needed for `AppRegistry.runApplication()`:
- `RCTBridgeProxy` (legacy compat)
- `RCTDevMenuConfigurationDecorator`
- `RCTBundleManager` (only needed for URL management, not evaluation)
- Inspector target
- Performance logger

**For Ferrum Phase 0** (which does NOT run `AppRegistry`): only items 1-2 plus error handling are needed.

### Question #5: Can Rust-owned Android process satisfy Activity lifecycle for Fabric?

**Yes, but with significant effort.**

The Android Fabric renderer assumes it runs inside an `Activity` with access to:
- `ReactRootView` — a `ViewGroup` that hosts the React UI
- `ReactInstanceManager` — manages the JS runtime lifecycle
- Activity lifecycle callbacks: `onResume`, `onPause`, `onDestroy`
- `Choreographer` — frame scheduling (Android equivalent of CADisplayLink)

For a Rust-owned process using `NativeActivity` (via the `jni` crate):
- `NativeActivity` IS an `Activity` subclass — satisfies all lifecycle requirements
- Choreographer is accessible from any thread via `AChoreographer_getInstance()`
- `ViewGroup` creation requires the Activity context

Alternatively, for a Rust binary that does NOT use `NativeActivity`:
- Must create a minimal `Activity` subclass in Java/Kotlin
- JNI bridge from Rust to invoke lifecycle methods
- `android.app.NativeActivity` provides this with minimal Java boilerplate

The key challenge is not lifecycle satisfaction but **the Java interop overhead**. Meta's own Quest VR integration confirms that React Native on Android-based Horizon OS works with "minimal changes" to standard Android tooling, suggesting the Activity abstraction is sufficiently flexible.

**Verdict**: A `NativeActivity`-based approach satisfies Fabric lifecycle requirements. For Phase 0 (no Fabric), the Activity is needed only to obtain a window for potential future UI — not for JS evaluation.

## Binary Size Analysis

### Hermes Engine Sizes

| Configuration | Size | Notes |
|---------------|------|-------|
| Hermes Full (release, arm64) | ~4.5 MB | Includes all features |
| Hermes Lean (release, arm64) | ~3 MB | Reduced feature set |
| QuickJS (for comparison) | ~1 MB | Minimal JS engine |
| JavaScriptCore (for comparison) | ~8-12 MB | Full-featured, JIT capable |

Hermes as bundled in React Native iOS (`.xcframework`):
- As of RN 0.84, ships as precompiled binaries downloaded during `pod install`
- Eliminates source compilation — 8x faster clean builds on M4 Macs
- The `.xcframework` includes arm64 (device) + x86_64/arm64 (simulator)

### Hermes Standalone Linking

Building Hermes as a standalone C library via CMake:
- Output: `hermes.framework` (iOS) or `libhermes.so` (Android)
- CMake variables: `CMAKE_OSX_SYSROOT`, `CMAKE_OSX_ARCHITECTURES`, `CMAKE_OSX_DEPLOYMENT_TARGET`
- Supports per-platform builds combined via `lipo` for universal binaries
- **No React Native dependency** — Hermes builds independently

### Fabric Size Estimate

Fabric's C++ core is shared across platforms. Isolating it is non-trivial because it's built as part of the React Native monorepo. Estimated sizes:

| Component | Estimated Size | Notes |
|-----------|---------------|-------|
| Fabric renderer (C++) | ~2-4 MB | Shadow tree, diffing, mounting |
| React Native core (iOS) | ~5-8 MB | Full framework minus Hermes |
| Turbo Module infra | ~1-2 MB | Module registration + codegen |

### Ferrum Phase 0 Binary Overhead

For Phase 0 (Hermes only, no Fabric, no RN):
- Hermes Lean: **~3 MB** added to the Rust binary
- Rust binary (release, stripped): **~1-3 MB** typical for a minimal binary
- **Total estimate: ~4-6 MB** for a Phase 0 proof-of-concept

This compares favorably to:
- A minimal React Native app: ~15-25 MB
- Game engines with embedded JS: ~5-15 MB (Unity + QuickJS, Unreal + V8)

### Answer to Open Question #6

> Binary size overhead of linking Hermes as C lib vs bundled Hermes?

Linking Hermes as a standalone C library adds **~3-4.5 MB** (lean vs full configuration). This is comparable to the bundled Hermes in React Native, since RN 0.84 already ships precompiled Hermes binaries — the engine size is the same either way. The difference is that Ferrum avoids the ~10-20 MB overhead of the rest of React Native's native code.

## Implications for Ferrum Architecture

### Phase 0: Clean Path Forward

The audit confirms Phase 0 requires minimal infrastructure:

```
Ferrum Phase 0 Stack:
  Rust binary (~2 MB)
    └── Hermes C ABI (~3 MB, linked as static lib)
         └── JS bundle (evaluated at startup)
              └── calls rust_add() via registered global
```

No RCTHost, no ReactInstance, no TurboModules, no bridge, no surface presenter.

### Phase 1+: Selective Reconstruction

When adding Fabric rendering, Ferrum must reconstruct a subset of what RCTInstance does:

1. **TimerManager** — reimplement in Rust using platform timers
2. **RuntimeScheduler** — Rust async runtime (tokio or custom)
3. **SurfacePresenter** — `FerumFabric` wrapping Fabric C++ core via cxx
4. **Display Link** — objc2 CADisplayLink (iOS) / JNI Choreographer (Android)
5. **Module Registry** — plain function pointer registration (already in Phase 0)

Items Ferrum permanently skips:
- RCTBridgeProxy, RCTBundleManager, RCTBridgeModuleDecorator
- Legacy architecture compatibility code
- TurboModule codegen infrastructure

## Sources

- [RCTInstance.mm](https://github.com/facebook/react-native/blob/main/packages/react-native/ReactCommon/react/runtime/platform/ios/ReactCommon/RCTInstance.mm)
- [ReactInstance.cpp](https://github.com/facebook/react-native/blob/main/packages/react-native/ReactCommon/react/runtime/ReactInstance.cpp)
- [ReactInstance.h](https://github.com/facebook/react-native/blob/main/packages/react-native/ReactCommon/react/runtime/ReactInstance.h)
- [React Native 0.84 blog post](https://reactnative.dev/blog/2026/02/11/react-native-0.84)
- [Fabric renderer architecture](https://reactnative.dev/architecture/fabric-renderer)
- [Render, Commit, and Mount pipeline](https://reactnative.dev/architecture/render-pipeline)
- [React Native comes to Meta Quest](https://reactnative.dev/blog/2026/02/24/react-native-comes-to-meta-quest)
- [Host/Instance Management discussion](https://github.com/react-native-community/discussions-and-proposals/issues/183)
- [Hermes vs QuickJS binary size comparison](https://www.fractolog.com/2025/04/comparing-hermes-and-quickjs/)
- [Compiling Hermes for Apple Platforms — Callstack](https://www.callstack.com/blog/technical-guide-compiling-hermes-for-apple-platforms)
- [Hermes engineering blog post](https://engineering.fb.com/2019/07/12/android/hermes/)
