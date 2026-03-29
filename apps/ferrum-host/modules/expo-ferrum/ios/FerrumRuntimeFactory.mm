/// FerrumRuntimeFactory — the Ferrum orchestrator.

#import <Foundation/Foundation.h>
#include <react/runtime/JSRuntimeFactory.h>
#include <hermes_abi/hermes_abi.h>
#include <hermes_abi/hermes_vtable.h>
#include <hermes_abi/HermesABIRuntimeWrapper.h>

// C-linkage accessors (defined in HermesABIRuntimeWrapper.cpp, compiled into hermesvm.framework)
extern "C" HermesABIRuntime *ferrum_get_abi_runtime(facebook::jsi::Runtime *wrapper);
extern "C" const HermesABIRuntimeVTable *ferrum_get_abi_vtable(facebook::jsi::Runtime *wrapper);

// Rust FFI
extern "C" void ferrum_register_globals(HermesABIRuntime *rt, const HermesABIRuntimeVTable *vt);

namespace ferrum {

class FerrumRuntimeFactory : public facebook::react::JSRuntimeFactory {
public:
  std::unique_ptr<facebook::react::JSRuntime> createJSRuntime(
      std::shared_ptr<facebook::react::MessageQueueThread> msgQueueThread) noexcept override {

    NSLog(@"[Ferrum] FerrumRuntimeFactory::createJSRuntime");

    // 1. Create wrapper (standard API)
    const HermesABIVTable *vtable = get_hermes_abi_vtable();
    auto jsiRuntime = facebook::hermes::makeHermesABIRuntimeWrapper(vtable);

    // 2. Get C ABI handle from the wrapper we own
    HermesABIRuntime *abiRt = ferrum_get_abi_runtime(jsiRuntime.get());
    NSLog(@"[Ferrum] Got C ABI handle");

    // 3. Register Rust functions at C ABI level (0.20μs path)
    ferrum_register_globals(abiRt, ferrum_get_abi_vtable(jsiRuntime.get()));
    NSLog(@"[Ferrum] Rust globals registered");

    // 4. Hand to React
    NSLog(@"[Ferrum] Handing to ReactInstance");
    return std::make_unique<facebook::react::JSIRuntimeHolder>(std::move(jsiRuntime));
  }
};

} // namespace ferrum

extern "C" void *jsrt_create_ferrum_factory(void) {
  NSLog(@"[Ferrum] jsrt_create_ferrum_factory");
  return reinterpret_cast<void *>(new ferrum::FerrumRuntimeFactory());
}
