/// Minimal FerrumRuntimeFactory — testing if C ABI runtime works with React at all.

#import <Foundation/Foundation.h>
#include <react/runtime/JSRuntimeFactory.h>
#include <hermes_abi/hermes_vtable.h>
#include <hermes_abi/HermesABIRuntimeWrapper.h>

namespace ferrum {

class FerrumRuntimeFactory : public facebook::react::JSRuntimeFactory {
public:
  std::unique_ptr<facebook::react::JSRuntime> createJSRuntime(
      std::shared_ptr<facebook::react::MessageQueueThread> msgQueueThread) noexcept override {

    NSLog(@"[Ferrum] Creating runtime via makeHermesABIRuntimeWrapper (standard, no FromExisting)");

    // Use the STANDARD wrapper — creates its own runtime.
    // No Rust registration. Just testing if the C ABI runtime works with React.
    const HermesABIVTable *vtable = get_hermes_abi_vtable();
    auto jsiRuntime = facebook::hermes::makeHermesABIRuntimeWrapper(vtable);

    NSLog(@"[Ferrum] Standard C ABI wrapper created, handing to ReactInstance");
    return std::make_unique<facebook::react::JSIRuntimeHolder>(std::move(jsiRuntime));
  }
};

} // namespace ferrum

extern "C" void *jsrt_create_ferrum_factory(void) {
  NSLog(@"[Ferrum] jsrt_create_ferrum_factory (minimal test)");
  return reinterpret_cast<void *>(new ferrum::FerrumRuntimeFactory());
}
