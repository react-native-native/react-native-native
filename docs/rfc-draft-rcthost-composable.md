# RFC: RCTHost as Composable Components for Embedded Runtimes

> Draft outline for `react-native-community/discussions-and-proposals`
>
> Status: DRAFT — internal to Project Ferrum, not yet submitted

---

## Title

**RCTHost as Composable Components for Embedded Runtimes**

## Authors

Kim Brandwijk (Project Ferrum)

## Summary

React Native's host initialization (`RCTHost` on iOS, `ReactHost` on Android) is currently a monolithic orchestrator that assembles ~12 tightly coupled subsystems in a fixed sequence. This makes it difficult to embed React Native's rendering and runtime capabilities in non-standard host environments — VR headsets, game engines, embedded devices, server-side renderers, or alternative language runtimes.

This RFC proposes decomposing RCTHost into a set of composable, independently initializable components with well-defined interfaces. Hosts would assemble only the components they need, in whatever order their environment requires.

## Motivation

### The Embeddability Gap

React Native has proven its value beyond mobile phones:
- **Meta Quest**: React Native now runs on HorizonOS for VR applications (announced React Conf 2025, shipped with RN 0.84+)
- **Meta internal**: Facebook and Instagram rebuilt for Quest using React Native
- **Server-side rendering**: React Native Skia runs headlessly on Node.js for OG image generation
- **Desktop**: React Native for Windows, macOS
- **TV**: React Native for tvOS, Android TV

Each of these targets required significant custom integration work because RCTHost assumes it owns the full application lifecycle. Teams building these integrations repeatedly solve the same decomposition problem: extracting the parts of RCTHost they need and replacing the parts they don't.

### What Blocks New Embedders Today

1. **Runtime initialization is coupled to bundle loading** — you can't create a Hermes runtime and evaluate arbitrary JS without also setting up the TurboModule infrastructure
2. **Display link / frame scheduling is hardcoded** — `RCTDisplayLink` wraps `CADisplayLink` (iOS) or `Choreographer` (Android). VR headsets, game engines, and servers have their own frame loops
3. **Surface presenter assumes platform views** — Fabric mounting assumes `UIView` (iOS) or `ViewGroup` (Android). Custom renderers (Skia, Metal, Vulkan) need a different mounting target
4. **Module registry requires the full bridge/bridgeless stack** — registering a native function accessible from JS requires either the legacy bridge or TurboModule infrastructure, even when a simple function pointer would suffice

### Meta's Own Direction Validates This

The precompiled Hermes binaries in RN 0.84, the Quest VR integration, and RFC 0759 ("React Native Frameworks") all point toward greater composability. This RFC proposes making that composability explicit and stable.

## Proposed Changes

### Component Decomposition

Decompose RCTHost into these independently initializable components:

#### 1. Runtime Initialization (decoupled from host)

```
Component: RuntimeCore
Inputs:   JSRuntimeFactory, RuntimeConfig
Outputs:  JSRuntime, RuntimeExecutor
Depends:  nothing
```

Create and configure a Hermes (or any JSI-compatible) runtime without any RN-specific globals, modules, or infrastructure. The runtime is usable for arbitrary JS evaluation immediately.

Today, `ReactInstance` mixes runtime creation with RN-specific global installation (`RN$Bridgeless`, timer globals, callable module setup). These should be separated:
- `RuntimeCore`: creates the runtime, provides executors
- `RNGlobalsInstaller`: installs RN-specific globals (opt-in for RN apps, skipped by custom embedders)

#### 2. Display Link / Render Scheduling (pluggable)

```
Component: FrameScheduler
Protocol:  requestFrame(callback) → cancel_token
           now() → timestamp
Depends:   nothing (platform-specific implementation)
```

Define a platform-agnostic protocol for frame-synchronized callbacks. Provide default implementations:
- `CADisplayLinkScheduler` (iOS)
- `ChoreographerScheduler` (Android)
- `ManualScheduler` (testing, server-side, custom embedders)

Today, `RCTDisplayLink` is hardcoded. Game engines (Unity, Unreal) and VR runtimes have their own render loops. The frame scheduler should be injected, not assumed.

#### 3. Bundle Loading (standalone)

```
Component: BundleLoader
Inputs:    RuntimeExecutor, BundleSource (file/network/memory)
Outputs:   loaded signal, error
Depends:   RuntimeCore
```

Load and evaluate a JS bundle on a runtime. Currently tangled with:
- `RCTBundleManager` (URL management)
- Metro dev server integration
- Hot module replacement

The core operation — "take bytes, evaluate on runtime" — should be a single function call. Higher-level features (dev server, HMR) layer on top.

#### 4. View Mounting (main-thread scheduler interface)

```
Component: MountingCoordinator
Protocol:  scheduleMountItems(items) → void
           getCurrentSurface() → SurfaceHandle
Depends:   FrameScheduler (for batching), platform view layer
```

Fabric's shadow tree diffing is pure C++ and platform-independent. The mounting step — creating/updating/deleting native views — is platform-specific. Define a clear interface between the two:
- Shadow tree operations: platform-independent, any thread
- Mount operations: platform-specific, main thread (or custom thread for game engines)

Custom embedders provide their own `MountingCoordinator`:
- iOS default: creates `UIView` instances
- Android default: creates `View` instances
- Game engine: updates scene graph nodes
- Server-side: serializes to HTML/SVG
- Custom Rust renderer: creates platform-native views via FFI

#### 5. Module Registry (optional for embedded hosts)

```
Component: ModuleRegistry
Protocol:  register(name, factory) → void
           get(name) → NativeModule?
Depends:   RuntimeCore
```

Today, registering a native function requires:
- TurboModule infrastructure (codegen, type safety layer)
- OR legacy bridge module registration

For embedded hosts, a simpler path should be available:
- Register plain function pointers as JS globals
- No codegen, no module spec, no bridge

This is what the Hermes C ABI's `create_function_from_host_function` + `set_object_property` already enables. The module registry should be optional infrastructure layered on top, not a prerequisite.

## Component Dependency Graph

```
RuntimeCore ─────────────────────────────────────┐
    │                                              │
    ├── BundleLoader                               │
    │                                              │
    ├── RNGlobalsInstaller (optional)              │
    │       │                                      │
    │       └── TimerManager ── FrameScheduler     │
    │                              │               │
    ├── ModuleRegistry (optional)  │               │
    │                              │               │
    └── SurfacePresenter ──────────┘               │
            │                                      │
            └── MountingCoordinator ───────────────┘
                    │
                    └── Platform View Layer (UIView / ViewGroup / custom)
```

Minimal embedder (Phase 0 Ferrum-style): `RuntimeCore` + `BundleLoader`

Standard RN app: all components assembled in the default order (equivalent to today's RCTHost)

## Example: Minimal Embedding

```
// Pseudocode — what a Rust/C/Go embedder would do

runtime = RuntimeCore.create(HermesFactory, config)
runtime.registerGlobalFunction("native_add", nativeAddImpl)
BundleLoader.load(runtime, bundleBytes)
// JS code calls native_add(1, 2) synchronously
```

No surface presenter, no module registry, no frame scheduler. The runtime evaluates JS and calls native functions.

## Example: Game Engine Integration

```
runtime = RuntimeCore.create(HermesFactory, config)
RNGlobalsInstaller.install(runtime)
ModuleRegistry.register(runtime, gameModules)

scheduler = GameEngineFrameScheduler(engine.renderLoop)
timers = TimerManager(scheduler)
timers.install(runtime)

surface = SurfacePresenter.create(runtime, scheduler)
mounting = GameSceneMountingCoordinator(engine.sceneGraph)
surface.setMountingCoordinator(mounting)

BundleLoader.load(runtime, bundleBytes)
AppRegistry.runApplication("GameUI", surface)
```

## Migration Path

### For Existing Apps

No changes required. `RCTHost` / `ReactHost` continue to work exactly as today — they become convenience wrappers that assemble all components in the standard configuration.

```objc
// This continues to work unchanged:
RCTHost *host = [[RCTHost alloc] initWithBundleURL:bundleURL ...];
```

### For Framework Authors (Expo, etc.)

Frameworks gain the ability to customize individual components without forking RCTHost:
- Custom bundle loaders (OTA updates)
- Custom frame schedulers (background rendering)
- Custom module registries (platform-specific modules)

### For New Platform Targets

New platforms implement only what they need:
- VR: custom frame scheduler + custom mounting coordinator
- Server: no frame scheduler, no mounting (or serialization-based mounting)
- Embedded devices: minimal runtime + bundle loader

## Backwards Compatibility

- `RCTHost` and `ReactHost` remain the recommended entry point for standard apps
- All new interfaces are additive — no existing API is removed or modified
- Components use the same underlying C++ (ReactInstance, Fabric) — this is a refactoring of the assembly, not a rewrite
- The internal implementation of RCTHost changes from direct instantiation to component assembly, but the external interface is unchanged

## Prior Art and Related Work

### Within React Native Ecosystem
- **RFC 0759: React Native Frameworks** — establishes the boundary between core and framework. This RFC proposes making core itself composable below that boundary
- **Host/Instance Management discussion (#183)** — early discussion of RCTHost decomposition
- **React Native for Meta Quest** — demonstrates that RN can run in non-standard Android environments with "minimal changes"
- **React Native Skia headless rendering** — proves the rendering pipeline can work without standard platform views

### External
- **WebKit's WKWebView** — composable embedding: you choose which delegates to implement
- **Chromium's Content API** — embeddable browser engine with pluggable content handling
- **Flutter's embedder API** — pluggable platform views and render surfaces
- **libGDX / SDL** — game frameworks with pluggable rendering backends

## Open Questions

1. **Versioning**: Should components have independent version numbers, or track the RN release?
2. **C++ API stability**: Should the component interfaces be C++ (current), C (for cross-language), or both?
3. **Default assembly**: Should there be a `DefaultHostAssembler` that replicates current RCTHost behavior from components?
4. **Testing**: How do we test component combinations that don't match the standard RN app configuration?
5. **Performance**: Does the indirection of pluggable components add measurable overhead to the render pipeline?

## Implementation Phases

### Phase A: Define Interfaces
- Extract component protocols from existing RCTHost/RCTInstance code
- Document required vs optional components
- No behavior change — pure refactoring

### Phase B: Internal Decomposition
- Refactor RCTHost internals to use component assembly
- RCTHost becomes a convenience wrapper
- All existing tests continue to pass

### Phase C: Public API
- Expose component interfaces as public, stable APIs
- Provide documentation and example embeddings
- Deprecate internal-only access patterns that embedders currently rely on

## Appendix: Current RCTInstance Subsystems

| # | Subsystem | Component Target | Removable for Minimal Embed? |
|---|-----------|-----------------|------------------------------|
| 1 | RCTPerformanceLogger | (instrumentation) | Yes |
| 2 | RCTJSThreadManager | RuntimeCore | No |
| 3 | RCTBridgeModuleDecorator | (legacy compat) | Yes |
| 4 | ObjCTimerRegistry → TimerManager | TimerManager | Yes (if no timers) |
| 5 | JSRuntime (Hermes) | RuntimeCore | No |
| 6 | ReactInstance (C++) | RuntimeCore | No |
| 7 | RCTBridgeProxy | (legacy compat) | Yes |
| 8 | RuntimeSchedulerCallInvoker | RuntimeCore | Implicit |
| 9 | RCTTurboModuleManager | ModuleRegistry | Yes |
| 10 | Context container | (shared state) | Partially |
| 11 | RCTSurfacePresenter | SurfacePresenter | Yes (if no UI) |
| 12 | RCTDisplayLink | FrameScheduler | Yes (if no UI) |
| 13 | initializeRuntime | RNGlobalsInstaller | Partially |
| 14 | Bundle loading | BundleLoader | No |

---

*This RFC is drafted by Project Ferrum to frame the upstream conversation. It should be reviewed and refined before submission to react-native-community/discussions-and-proposals.*
