/// FerrumRuntimeFactory — combines standard HermesRuntime with C ABI registration.
///
/// Delegates to the default factory for a fully-featured HermesRuntime,
/// then temporarily wraps its vm::Runtime in a C ABI handle to register
/// Rust function pointers. The temporary wrapper is destroyed before JS starts.
/// The registrations persist on the shared vm::Runtime.

#import <Foundation/Foundation.h>
#include <react/runtime/JSRuntimeFactory.h>
#include <hermes/hermes.h>
#include <hermes_abi/hermes_abi.h>

// Vendored Hermes functions
extern "C" HermesABIRuntime *ferrum_wrap_vm_runtime(void *vmRuntime);
extern "C" void ferrum_release_borrowed_runtime(HermesABIRuntime *abiRt);

// Rust FFI
extern "C" void ferrum_register_globals(HermesABIRuntime *rt, const HermesABIRuntimeVTable *vt);

// Default Hermes factory (from RN)
extern "C" void *jsrt_create_hermes_factory(void);

namespace ferrum {

class FerrumRuntimeFactory : public facebook::react::JSRuntimeFactory {
public:
  std::unique_ptr<facebook::react::JSRuntime> createJSRuntime(
      std::shared_ptr<facebook::react::MessageQueueThread> msgQueueThread) noexcept override {

    NSLog(@"[Ferrum] FerrumRuntimeFactory: creating standard HermesRuntime");

    // 1. Create standard HermesRuntime via the default factory — full features
    auto *defaultFactory = reinterpret_cast<facebook::react::JSRuntimeFactory *>(
        jsrt_create_hermes_factory());
    auto jsRuntime = defaultFactory->createJSRuntime(msgQueueThread);
    delete defaultFactory;

    NSLog(@"[Ferrum] Standard HermesRuntime created, extracting vm::Runtime");

    // 2. Get vm::Runtime from HermesRuntime via vendored getter
    auto &jsiRuntime = jsRuntime->getRuntime();
    auto *hermesRuntime = static_cast<facebook::hermes::HermesRuntime *>(&jsiRuntime);
    void *vmRuntime = hermesRuntime->getVMRuntimeUnsafe();

    if (!vmRuntime) {
      NSLog(@"[Ferrum] WARNING: getVMRuntimeUnsafe returned null");
      return jsRuntime;
    }

    NSLog(@"[Ferrum] Got vm::Runtime, creating temporary C ABI wrapper");

    // 3. C ABI wrap — register Rust functions
    // Wrapper is leaked (not destroyed) because registered host functions
    // hold managed pointer references tracked by the wrapper. The non-owning
    // shared_ptr means no runtime leak — only the wrapper object (~200 bytes).
    HermesABIRuntime *abiRt = ferrum_wrap_vm_runtime(vmRuntime);
    ferrum_register_globals(abiRt, abiRt->vt);
    // abiRt intentionally leaked

    NSLog(@"[Ferrum] Rust globals registered, returning standard HermesRuntime");

    // 4. Return the standard HermesRuntime — fully featured, no stubs
    return jsRuntime;
  }
};

} // namespace ferrum

extern "C" void *jsrt_create_ferrum_factory(void) {
  NSLog(@"[Ferrum] jsrt_create_ferrum_factory");
  return reinterpret_cast<void *>(new ferrum::FerrumRuntimeFactory());
}
