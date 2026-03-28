/// FerrumRuntimeFactory — the Ferrum orchestrator's single injection point.
///
/// Replaces the standard Hermes JSRuntimeFactory. Creates Hermes via the
/// C ABI, registers Rust function pointers, then wraps as jsi::Runtime.

#include "FerrumRuntimeFactory.h"

// Include the FULL HermesABIRuntimeWrapper implementation.
// This is a .cpp file, not a header — we include it to get the
// HermesABIRuntimeWrapper class definition so we can subclass or
// construct it with our own runtime.
//
// This is unconventional but necessary: the class is not exposed via
// any public header, and we need to either subclass it or access abiRt_.
// Phase 2 will upstream a proper constructor that accepts an existing runtime.
#include <hermes_abi/HermesABIRuntimeWrapper.cpp>

namespace ferrum {

/// A subclass that creates the runtime BEFORE the wrapper, so we can
/// register Rust functions on the raw C ABI before JSI wrapping happens.
class FerrumABIRuntimeWrapper : public facebook::hermes::HermesABIRuntimeWrapper {
public:
  FerrumABIRuntimeWrapper(const HermesABIVTable *vtable)
      : HermesABIRuntimeWrapper(vtable) {
    // At this point, abiRt_ is live (created by parent constructor).
    // Register Rust functions on it via C ABI.
    NSLog(@"[Ferrum] Registering Rust globals on C ABI runtime...");
    ferrum_register_globals(abiRt_, vtable_);
    NSLog(@"[Ferrum] Rust globals registered");
  }
};

std::unique_ptr<facebook::react::JSRuntime>
FerrumRuntimeFactory::createJSRuntime(
    std::shared_ptr<facebook::react::MessageQueueThread> msgQueueThread) noexcept {

  NSLog(@"[Ferrum] FerrumRuntimeFactory: creating Hermes V1 via C ABI");

  const HermesABIVTable *vtable = get_hermes_abi_vtable();

  // Create our wrapper (registers Rust globals in constructor)
  auto runtime = std::make_unique<FerrumABIRuntimeWrapper>(vtable);

  NSLog(@"[Ferrum] Handing jsi::Runtime to ReactInstance");

  return std::make_unique<facebook::react::JSIRuntimeHolder>(std::move(runtime));
}

} // namespace ferrum
