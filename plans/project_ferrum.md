# Project Ferrum
## Rust-Hosted React Native: Architecture Plan
_Kim Brandwijk · March 2026 · v1.0_

---

## TL;DR

Invert the React Native host model so a Rust binary owns the OS process and embeds the Hermes JS runtime as a scripting guest — eliminating the module bridge, enabling direct GPU/camera access, and proving the game-engine architecture pattern on mobile.

---

## 1. Context and Motivation

Every React Native module system — Legacy Bridge, TurboModules, Expo Modules, Nitro Modules — shares the same ownership model: an Objective-C or Java process owns the app, creates a Hermes runtime as a guest, and native code is registered into it through a module protocol.

This ownership model creates three persistent problems that no amount of bridge optimisation resolves:

- **GPU/camera boundary**: high-bandwidth data (camera frames, audio buffers, GPU textures) crosses the JS/native boundary through function calls, requiring ownership negotiation on every frame
- **Module authorship complexity**: writing a performant RN module requires five separate systems — TypeScript spec, codegen, C++ JSI or Swift/Kotlin bindings, CMake/CocoaPods/Gradle, and autolinking conventions
- **Cross-platform fragmentation**: every out-of-tree platform (Windows, macOS, visionOS, VR) must reimplement the host entanglement from scratch

Project Ferrum inverts this model. Rust owns the OS process. Hermes is an embedded scripting runtime inside that process. The module system is replaced by direct function registration. React and Fabric become guests that the Rust host invites in.

This is not novel in software engineering — it is exactly how game engines have worked for 20 years: a native engine process embeds a scripting runtime (Lua, Python, C#/Mono, GDScript) and the scripting layer drives logic without any bridge protocol. Project Ferrum applies this proven model to mobile React Native development.

---

## 2. Architecture Overview

### Current model (what we are replacing)

```
OS Process (Swift / ObjC / Kotlin / Java)
  └── RCTHost / ReactInstance
        ├── Hermes runtime              [guest]
        ├── Fabric shadow tree          [guest]
        ├── TurboModule / Nitro registry [guest]
        └── native modules              [registered via protocol]
```

### Target model (Project Ferrum)

```
OS Process (Rust binary)
  ├── Hermes runtime              [embedded via stable C ABI]
  │     └── React / JS bundle    [scripting guest]
  ├── FerumFabric                 [Fabric as linkable library]
  │     ├── CADisplayLink / Choreographer  [driven by Rust]
  │     └── shadow tree mutations [scheduled by Rust → main thread]
  ├── Module registration         [plain function pointers at startup]
  │     runtime.set_global("camera", camera::js_api());
  │     runtime.set_global("gpu",    gpu::js_api());
  └── SharedArrayBuffer channels  [zero-copy data pipelines]
```

### Key differences from all existing RN module systems

- No module registration protocol — Rust hands function pointers to Hermes at startup
- No codegen — type safety lives in Rust, JS sees plain objects
- No C++ bridge layer — Rust calls the Hermes C ABI directly
- No JSI host objects, no TurboModule spec files, no nitrogen, no UniFFI for the hot path
- GPU and camera data shared via SharedArrayBuffer — Rust writes, JS reads, zero copy

---

## 3. Technical Foundations

### 3.1 Hermes C ABI

Hermes exposes two embedding surfaces. JSI is the primary C++ API but is subject to C++ ABI instability across toolchains. The Hermes ABI (`hermes_abi.h`) is a stable C-based interface specifically designed for cross-toolchain embedding — exactly what Rust needs. Rust links against the C ABI with no C++ interop required.

As of React Native 0.84, Hermes V1 is the default engine and ships as precompiled iOS binaries. Meta is already distributing Hermes as a linkable library — the embedding model is the direction they are moving toward independently.

### 3.2 Fabric host entanglement

The `RCTHost` / `ReactInstance` bootstrap currently bundles four concerns that need to be separated:

| Concern | Current state | Ferrum approach |
|---|---|---|
| Hermes runtime init | Inside `RCTHost`, tightly coupled | Rust calls Hermes C ABI directly |
| Display link (render tick) | `UIApplication` / `CADisplayLink` assumption | Rust owns via `objc2` crate / JNI |
| View mounting | `UIView` alloc on main thread via ObjC | Rust schedules via `dispatch_async` (C fn) |
| Module registry | TurboModule registry, codegen required | Replaced by fn ptr registration |
| JS bundle loading | Metro coupled to `RCTHost` | Plain bytes fed to Hermes runtime |

### 3.3 Rust platform ecosystem

Relevant crates for platform interaction:

- `objc2` — full Objective-C runtime access from Rust: `CADisplayLink`, `UIView` hierarchy, GCD dispatch
- `jni` — JNI bindings for Android: `Choreographer`, `ViewGroup` operations
- `android-ndk` — Android NDK bindings for lower-level native access
- `winit` — cross-platform window / run loop management with iOS and Android backends
- `cxx` — safe C++ interop from Rust, needed for Fabric shadow tree FFI

---

## 4. Phased Execution Plan

> **Gate policy**: each phase does not close until success criteria are met on physical device — not simulator, not unit tests.

---

### Phase 0 — Prove the Embedding
**Duration**: 2–4 weeks (hard timebox) | **Type**: Spike

The entire project rests on one assumption: a Rust binary can own a mobile process, embed Hermes, and call Rust functions from JS. This phase proves or disproves that before any architecture work begins.

#### Objective

A cargo-native binary that boots on an iOS device and an Android device, evaluates a JS bundle, and calls a Rust function from JS synchronously — with no React, no Fabric, no RN.

#### Tasks

1. Write Rust bindings to the Hermes stable C ABI (`hermes_abi.h`). Target: create runtime, load bytecode, evaluate bundle.
2. Create a minimal Cargo binary project with iOS (`objc2`) and Android (`jni`) bootstrap — equivalent to what a game engine does to own the process entry point.
3. Register a single Rust function (e.g. `rust_add(a, b) -> number`) as a JS global via the Hermes runtime API.
4. Write a trivial JS bundle that calls `rust_add` and `console.log`s the result.
5. Run on physical iOS device and physical Android device. Confirm the output.
6. Benchmark: measure call overhead (JS → Rust → JS) vs an equivalent JSI host function in a standard RN app. Target device: Snapdragon 778G (mid-range Android) and A15 (iPhone 13).

#### Deliverables

| Deliverable | Success criterion | Owner |
|---|---|---|
| Rust Hermes ABI bindings crate | Compiles for `aarch64-apple-ios` and `aarch64-linux-android` | Systems / Rust |
| iOS bootstrap binary | Boots on device, evaluates JS, calls Rust fn | iOS / Rust |
| Android bootstrap binary | Boots on device, evaluates JS, calls Rust fn | Android / Rust |
| Benchmark report | Call overhead documented vs JSI baseline | Any |

#### Phase 0 gate

> **STOP**: if call overhead JS → Rust → JS exceeds 50μs on either test device, convene before proceeding to Phase 1. Do not assume this is acceptable — measure it.

#### Open questions Phase 0 must answer

1. Does the Hermes stable C ABI expose enough surface to register JS globals without going through JSI C++, or is the C++ JSI layer required for global property setting?
2. Can Fabric's shadow tree be initialised without a `UIApplication` run loop present, or does it poll the run loop internally?
3. What is the minimum set of `RCTHost` initialisers that must be called before `AppRegistry.runApplication` produces output? Document each one.
4. Does the `objc2` crate's `CADisplayLink` binding correctly fire on the main thread when called from a Rust-owned secondary thread that dispatches to main?
5. On Android, can a Rust-owned process satisfy the `Activity` lifecycle requirements that Fabric expects, or does Fabric embed `Activity` assumptions more deeply?
6. What is the actual binary size overhead of linking Hermes as a C library vs the current bundled Hermes? Measure on both platforms.

---

### Phase 1 — Minimal Fabric Embedding
**Duration**: 6–10 weeks | **Type**: Build

Gets React rendering something inside the Rust-hosted Hermes runtime. The goal is not a complete solution — it is the minimum viable coupling to prove Fabric can function as a guest.

#### Step 1.1 — Display link from Rust

On iOS, create a `CADisplayLink` via the `objc2` crate from Rust. The Rust code owns the callback and drives the render tick. On Android, use `Choreographer` via JNI. This must run on the platform's main thread — Rust is responsible for bootstrapping the thread that satisfies this requirement.

**Deliverable**: Rust owns the display loop. A counter increments each frame, logged to console.

#### Step 1.2 — Shadow tree initialisation

Initialise Fabric's C++ shadow tree from Rust via C++ FFI (using the `cxx` crate or raw `extern C`). Identify the minimum set of `RCTHost` initialisation steps that are actually required vs assumed. Document every dependency touched.

**Deliverable**: Shadow tree initialised from Rust with no `RCTHost`. Component registry and event dispatcher wired up.

#### Step 1.3 — View mounting

Shadow tree mutations (create view, update props, insert child, delete) must execute on the main thread. Rust schedules this work via `dispatch_async` (iOS) or `runOnUiThread` (Android) — both are C-compatible functions callable from Rust without ObjC ownership.

**Deliverable**: A single hardcoded `Text` view mounts on screen, positioned correctly.

#### Step 1.4 — React bootstrap

Load a Metro-bundled React bundle into the Hermes runtime. The bundle renders a minimal React tree (one `View`, one `Text`). Call `AppRegistry.runApplication` from Rust after Hermes evaluates the bundle.

**Deliverable**: Hello World React app renders on device via Rust-hosted Hermes.

#### Step 1.5 — Touch events

Wire touch/gesture events from the platform (UIKit touch callbacks on iOS, `MotionEvent` on Android) into the Fabric event dispatcher. A button press in React should trigger a JS handler.

**Deliverable**: Tapping a React button increments a counter displayed on screen.

#### Phase 1 deliverables

| Deliverable | Success criterion | Owner |
|---|---|---|
| `FerumHost` crate (iOS) | Hello World React app on physical iOS device | iOS / Rust / C++ |
| `FerumHost` crate (Android) | Hello World React app on physical Android device | Android / Rust / C++ |
| Dependency audit | Complete list of `RCTHost` deps, categorised as required / optional / removable | Architecture |
| Touch event pipeline | Button tap triggers JS handler on both platforms | iOS + Android |

---

### Phase 2 — RCTHost Decomposition
**Duration**: 3–6 months | **Type**: Core

The structural heart of the project. `RCTHost` is refactored into independently initialisable components that a Rust host can assemble. Strategy: upstream to React Native where possible, fork as little as possible.

#### Target component architecture

| Component | Responsibility | Upstream candidate? |
|---|---|---|
| `RustHermesRuntime` | Wraps Hermes C ABI. Owns runtime lifecycle. Exposes fn ptr registration. | New crate — no upstream |
| `FerumFabric` | Drives display link, schedules mount mutations, owns shadow tree init. | Yes — RN embeddability RFC |
| `BundleLoader` | Reads bytes from disk or network, feeds to Hermes. No `RCTHost` coupling. | Yes — trivial extraction |
| `ComponentRegistry` | Kept as-is. Pure C++. Link against existing RN binary. | No change needed |
| `EventDispatcher` | Kept as-is. Pure C++. Platform events route into it from Rust. | No change needed |
| `ModuleRegistry` | Optional. Replaced by fn ptr registration. Retained only for compat. | Deprecated in Ferrum context |

#### Upstream contribution strategy

1. Open an RFC on `react-native-community/discussions-and-proposals` titled _"RCTHost as composable components for embedded runtimes"_. Frame it around embeddability generally, not Rust specifically. The VR use case (Instagram VR, Facebook VR are both RN) gives Meta direct incentive.
2. Submit the `BundleLoader` extraction as a standalone PR — small, low-risk, demonstrates intent.
3. Engage the RN architecture team on `FerumFabric`. The precompiled binary direction in 0.84 is a signal Meta wants RN to be more linkable.
4. Maintain a fork only for components upstream does not accept. Fork as little as possible.

#### Phase 2 deliverables

| Deliverable | Success criterion | Owner |
|---|---|---|
| `RustHermesRuntime` crate | Published to crates.io. Stable API for fn ptr registration. | Systems / Rust |
| `FerumFabric` crate | Fabric initialises and renders from Rust host on both platforms | Rust / C++ |
| Upstream RFC | Filed and acknowledged by Meta RN team | Architecture |
| Dependency audit v2 | `RCTHost` dependencies reduced >50% vs Phase 1 baseline | Architecture |
| CI integration test suite | Automated tests on both platforms via hardware farm | QA / Infra |

---

### Phase 3 — Rust Module System
**Duration**: Ongoing

With Rust owning the process and Fabric running as a guest, the module system is designed from first principles. No registration protocol, no codegen, no spec files.

#### Module registration pattern

```rust
// In your Rust binary's main:
fn register_modules(runtime: &mut HermesRuntime) {
    runtime.set_global("camera",  camera::js_api());
    runtime.set_global("gpu",     gpu::js_api());
    runtime.set_global("fs",      fs::js_api());
    runtime.set_global("sensors", sensors::js_api());
}

// js_api() returns a struct of extern "C" function pointers.
// Type safety is a Rust compile-time concern.
// JS sees plain objects — no HybridObject, no spec, no codegen.
```

#### High-bandwidth data — SharedArrayBuffer pattern

For camera frames, audio buffers, and GPU textures, function calls are the wrong primitive:

1. Rust allocates a `SharedArrayBuffer` and hands the JS runtime a reference at startup
2. Rust writes new data (camera frame, audio samples) directly into the buffer
3. Rust signals JS via a lightweight `postMessage` or `requestAnimationFrame` callback
4. JS reads from the buffer on the next frame — zero copy, zero serialisation

This eliminates the ownership negotiation that `react-native-webgpu-camera` currently requires on every frame.

#### Phase 3 deliverables

| Deliverable | Success criterion | Owner |
|---|---|---|
| `ferum-camera` module | Camera frames delivered to JS via SharedArrayBuffer | Camera / Rust |
| `ferum-gpu` module | WebGPU command submission from Rust, results accessible in JS | GPU / Rust |
| Module authoring guide | A Rust developer with no RN experience can write a module in under a day | Developer Relations |
| `ferum-cli` scaffold | `cargo ferum new my-module` generates a working module skeleton | Tooling |

---

## 5. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Fabric internal API breaks on RN version bumps | High | High | Minimise fork surface. Upstream as much as possible. Pin RN version during each phase. Assign one engineer to track RN release notes. |
| Phase 0 call overhead exceeds 50μs threshold | Low | Critical | If overhead fails gate, evaluate SharedMemory-only architecture as fallback before proceeding. Do not proceed to Phase 1 until resolved. |
| Meta does not accept upstream RFC | Medium | Medium | Proceed with fork for `FerumFabric`. Maintain as community project. Seek co-maintainers from out-of-tree platform authors (Windows, macOS, visionOS). |
| Swift C++ interop instability on iOS | Medium | Low | Ferrum does not rely on Swift C++ interop. Uses `objc2` (Rust → ObjC) and raw C ABI to Hermes. Apple's interop issues do not affect this path. |
| Android process bootstrap complexity | Medium | Medium | Validate on Android in Phase 0 before committing to Phase 1. Evaluate `winit` Android backend as alternative to raw JNI bootstrap. |
| Ecosystem adoption — only one team uses this | High | High | Frame upstream contributions early. Publish crates incrementally. Write the module authoring story before the architecture is complete so early adopters can start before Phase 3. |

---

## 6. What We Gain

### GPU and camera architecture

The `react-native-webgpu-camera` project exists because there is a boundary between the GPU pipeline (Rust/Metal) and React (JS). Every frame crossing that boundary requires ownership negotiation. In the Ferrum model, Rust owns the GPU command queue, Rust owns the camera session, and Rust decides when React renders. There is no boundary to negotiate — the zero-copy camera frame problem disappears.

### Genuine cross-platform

Every out-of-tree RN platform has reimplemented the host entanglement for its target. With Ferrum, porting to a new platform means: implement the display link equivalent in Rust for that platform, implement view mounting for that platform's UI framework. Hermes, React, Fabric, and all Rust modules are portable unchanged.

### Module authorship

Current cost to write a performant RN module: TypeScript spec syntax, codegen mechanics, C++ JSI or Swift/Kotlin + UniFFI, CMake or CocoaPods or Gradle, autolinking conventions — five separate systems. Ferrum cost: write Rust, expose `extern C` functions, register at startup. A Rust developer with no RN experience can write a module in a day.

### Build system

Primary build system becomes `cargo`. Hermes is a precompiled C library you link. React Native ships as a precompiled binary you link. Native modules are Rust crates. Metro handles the JS bundle. The multi-tool, multi-language build graph that breaks on every RN version becomes a single `cargo build`.

### Security and extension isolation

Hermes already has a sandbox runtime for isolated JS execution. In the Ferrum model, untrusted JS (third-party plugins, marketplace extensions, user scripts) runs in isolated Hermes instances with explicit capability grants from the Rust host. The Rust process controls exactly what each JS instance can call.

---

## 7. Agent Assignments — Phase 0

| Agent | Primary tasks | Key output |
|---|---|---|
| **Systems / Rust** | Write Hermes C ABI Rust bindings. Implement fn ptr registration. Benchmark call overhead on target devices. | `hermes-abi-rs` crate + benchmark report |
| **iOS / Rust** | Cargo binary that boots on iOS device. `CADisplayLink` via `objc2`. Evaluate JS bundle from Rust. | iOS bootstrap binary running on device |
| **Android / Rust** | Cargo binary that boots on Android device. JNI bootstrap. `Choreographer` from Rust. | Android bootstrap binary running on device |
| **Architecture** | `RCTHost` dependency audit. Identify which initialisers touch `UIApplication` vs pure C++. Draft upstream RFC outline. | Dependency map + RFC draft |

---

## 8. Decision Points

Phase 0 is a spike — hard timeboxed to 4 weeks. At the end of week 4, convene and answer:

- Did both platform binaries boot on device? If not, what blocked them?
- Did call overhead pass the 50μs gate on both target devices?
- Is the Hermes C ABI sufficient for fn ptr registration without JSI, or is JSI required?
- How deep is `UIApplication` / `Activity` coupling in Fabric? Is Phase 1 Step 1.2 tractable?

If all four answers are positive, proceed to Phase 1. If any answer is negative, document the finding and re-evaluate the architecture before committing Phase 1 resources.

---

_Project Ferrum · Internal · March 2026_
