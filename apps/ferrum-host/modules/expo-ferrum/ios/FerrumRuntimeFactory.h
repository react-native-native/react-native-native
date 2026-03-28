#pragma once

#include <react/runtime/JSRuntimeFactory.h>
#include <hermes_abi/hermes_abi.h>
#include <hermes_abi/hermes_vtable.h>

namespace ferrum {

/// Ferrum's JSRuntimeFactory: creates Hermes via the stable C ABI instead
/// of the C++ API, then wraps it as a jsi::Runtime for the rest of the
/// React Native stack.
///
/// This is the single injection point that makes Ferrum the orchestrator:
///   1. get_hermes_abi_vtable() → make_hermes_runtime()  (C ABI)
///   2. Register Rust functions via C ABI fn ptrs        (0.20μs path)
///   3. makeHermesABIRuntimeWrapper() → jsi::Runtime     (JSI wrapper)
///   4. Hand jsi::Runtime to ReactInstance                (standard RN)
///
/// The rest of the stack — React, Fabric, UIManagerBinding, component
/// views — sees a standard jsi::Runtime and works unchanged.
class FerrumRuntimeFactory : public facebook::react::JSRuntimeFactory {
public:
  std::unique_ptr<facebook::react::JSRuntime> createJSRuntime(
      std::shared_ptr<facebook::react::MessageQueueThread> msgQueueThread) noexcept override;
};

} // namespace ferrum

// C FFI: called from FerrumRuntimeFactory to register Rust globals
// on the C ABI runtime before it's wrapped in JSI.
extern "C" {
  /// Register all Rust-backed JS globals (rust_add, etc.) on the given
  /// HermesABIRuntime. Called from C++ before the runtime is wrapped.
  void ferrum_register_globals(HermesABIRuntime *rt, const HermesABIRuntimeVTable *vt);
}
