/// FerrumRuntimeFactory — the Ferrum orchestrator.
///
/// One C++ class, one method. Creates Hermes via C ABI, registers Rust
/// function pointers, wraps as jsi::Runtime. Single runtime, 0.20μs path.

#import <Foundation/Foundation.h>
#include <react/runtime/JSRuntimeFactory.h>
#include <hermes_abi/hermes_abi.h>
#include <hermes_abi/hermes_vtable.h>
#include <hermes_abi/HermesABIRuntimeWrapper.h>

// Rust FFI — registers function pointers on the C ABI runtime
extern "C" void ferrum_register_globals(
    HermesABIRuntime *rt,
    const HermesABIRuntimeVTable *vt);

namespace ferrum {

class FerrumRuntimeFactory : public facebook::react::JSRuntimeFactory {
public:
  std::unique_ptr<facebook::react::JSRuntime> createJSRuntime(
      std::shared_ptr<facebook::react::MessageQueueThread> msgQueueThread) noexcept override {

    NSLog(@"[Ferrum] FerrumRuntimeFactory::createJSRuntime");

    // 1. C ABI entry point
    const HermesABIVTable *vtable = get_hermes_abi_vtable();

    // 2. Create Hermes runtime via C ABI
    HermesABIRuntime *abiRt = vtable->make_hermes_runtime(nullptr);
    NSLog(@"[Ferrum] Hermes V1 runtime created via C ABI");

    // 3. Register Rust functions at the engine level (0.20μs path)
    ferrum_register_globals(abiRt, abiRt->vt);
    NSLog(@"[Ferrum] Rust globals registered via C ABI fn ptrs");

    // 4. Wrap this SAME runtime as jsi::Runtime for React/Fabric
    auto jsiRuntime = facebook::hermes::makeHermesABIRuntimeWrapperFromExisting(vtable, abiRt);
    NSLog(@"[Ferrum] Wrapped as jsi::Runtime — single runtime, handing to ReactInstance");

    return std::make_unique<facebook::react::JSIRuntimeHolder>(std::move(jsiRuntime));
  }
};

} // namespace ferrum

// C bridge for Swift
extern "C" void *jsrt_create_ferrum_factory(void) {
  NSLog(@"[Ferrum] jsrt_create_ferrum_factory");
  return reinterpret_cast<void *>(new ferrum::FerrumRuntimeFactory());
}
