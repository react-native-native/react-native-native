# Project Ferrum

Rust-hosted React Native: invert the RN host model so a Rust binary owns the OS process and embeds Hermes JS as a scripting guest.

## Architecture

```
OS Process (Rust binary)
  ├── Hermes runtime              [embedded via stable C ABI]
  │     └── React / JS bundle    [scripting guest]
  ├── FerumFabric                 [Fabric as linkable library]
  ├── Module registration         [plain function pointers at startup]
  └── SharedArrayBuffer channels  [zero-copy data pipelines]
```

Key principle: Ferrum is an orchestrator, not a renderer. Rust boots Hermes, initializes the existing Fabric C++ and platform component views, starts the render loop, and gets out of the way. All rendering code, component views, prop handlers, and layout (Yoga) are existing RN code linked as libraries. No fork, no reimplementation.

The new code Ferrum writes:
1. Boot Hermes → HermesABIRuntimeWrapper → jsi::Runtime
2. Init Scheduler, UIManagerBinding, ShadowTree, RuntimeScheduler without RCTHost
3. Start the render loop (CADisplayLink / AChoreographer)
4. Direct function pointer registration for native modules (additive, not replacing anything)

## Target Versions

- **React Native 0.84** — first release with Hermes V1 as default (Feb 2026)
- **Hermes V1** — stable C ABI (`hermes_abi.h`), vtable-dispatched function pointers
- **Expo SDK 56** (Q2 2026, RN 0.85) — expected Expo alignment by Phase 1
- Do NOT target RN 0.83 — Hermes V1 was experimental/opt-in, vtable layout may differ from finalized 0.84 ABI

## Current Phase: Phase 0 — Prove the Embedding

**Hard timebox**: 4 weeks (started 2026-03-28)

**Objective**: A cargo-native binary that boots on iOS and Android physical devices, evaluates a JS bundle, and calls a Rust function from JS synchronously — no React, no Fabric, no RN.

### Phase 0 Tasks
1. Rust bindings to Hermes stable C ABI (`hermes_abi.h`) — create runtime, load bytecode, evaluate bundle
2. Minimal Cargo binary with iOS (`objc2`) and Android (`jni`) bootstrap
3. Register a Rust function (`rust_add(a, b) -> number`) as a JS global
4. Trivial JS bundle that calls `rust_add` and logs the result
5. Run on physical iOS and Android devices
6. Benchmark: JS → Rust → JS call overhead vs JSI baseline (target devices: Snapdragon 778G, A15)

### Phase 0 Gate
- Call overhead JS → Rust → JS must NOT exceed 50μs on either device
- Both platforms must boot and evaluate JS successfully

### Open Questions Phase 0 Must Answer
1. Does Hermes stable C ABI expose enough surface for JS global registration without JSI C++?
2. Can Fabric shadow tree init without UIApplication run loop?
3. Minimum set of RCTHost initialisers needed before AppRegistry.runApplication?
4. Does objc2 CADisplayLink fire correctly from Rust-owned thread dispatched to main?
5. Can Rust-owned Android process satisfy Activity lifecycle for Fabric?
6. Binary size overhead of linking Hermes as C lib vs bundled Hermes?

## Project Structure

```
ferrum/
├── plans/                  # Architecture docs and planning
├── crates/
│   ├── hermes-abi-rs/      # Rust bindings to Hermes stable C ABI
│   ├── ferrum-ios/         # iOS bootstrap binary (objc2)
│   ├── ferrum-android/     # Android bootstrap binary (jni)
│   └── ferrum-core/        # Shared runtime initialization logic
├── js/                     # JS test bundles
└── benchmarks/             # Call overhead benchmarking
```

## Technical Foundations

- **Hermes C ABI** (`hermes_abi.h`): Stable C interface for cross-toolchain embedding. No C++ interop needed.
- **objc2**: Rust crate for full ObjC runtime access (CADisplayLink, UIView, GCD dispatch)
- **jni**: Rust crate for Android JNI bindings (Choreographer, ViewGroup)
- **cxx**: Safe C++ interop from Rust (needed later for Fabric shadow tree FFI)
- Target: `aarch64-apple-ios` and `aarch64-linux-android`

## Conventions

- Rust 2024 edition
- All crates in `crates/` workspace directory
- Unsafe code must be isolated behind safe abstractions with `// SAFETY:` comments
- No C++ interop in Phase 0 — pure C ABI only
- Gate policy: all success criteria verified on physical device, not simulator
