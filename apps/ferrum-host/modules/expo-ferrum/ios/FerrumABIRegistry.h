/// Ferrum C ABI bridge registry.
/// Generated code registers bridges via FERRUM_REGISTER_MODULE macro.
/// Runtime queries the registry to find C ABI bridges for TurboModules.
///
/// Callers must #include <hermes_abi/hermes_abi.h> BEFORE this header.

#pragma once

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

#ifdef HERMES_ABI_HERMES_ABI_H

/// Signature for a Ferrum C ABI bridge function.
typedef struct HermesABIValueOrError (*FerrumABIBridgeFn)(
    void *ctx,
    struct HermesABIRuntime *abiRt,
    const struct HermesABIRuntimeVTable *vt,
    const struct HermesABIValue *thisArg,
    const struct HermesABIValue *args,
    size_t count);

/// Entry in a module's bridge table.
typedef struct {
  const char *methodName;
  unsigned int argCount;
  FerrumABIBridgeFn fn;
} FerrumABIBridgeEntry;

/// Register a module's bridge table.
void ferrum_abi_register_module(
    const char *moduleName,
    const FerrumABIBridgeEntry *entries);

/// Look up a module's bridge table by name. Returns NULL if not found.
const FerrumABIBridgeEntry *ferrum_abi_lookup_module(const char *moduleName);

/// Look up a specific method bridge for a module. Returns NULL if not found.
FerrumABIBridgeFn ferrum_abi_lookup_method(
    const char *moduleName,
    const char *methodName);

/// Macro for generated code to auto-register at load time.
/// Uses __attribute__((constructor)) — requires -ObjC linker flag to prevent stripping.
#define FERRUM_REGISTER_MODULE(moduleName, entries)                            \
  __attribute__((constructor))                                                 \
  static void ferrum_register_##moduleName##_bridges(void) {                   \
    ferrum_abi_register_module(#moduleName, entries);                           \
  }

/// Get the CallInvoker pointer for scheduling callbacks on the JS thread.
/// Returns a void* to std::shared_ptr<CallInvoker>. May be NULL if not yet captured.
void *ferrum_get_js_invoker(void);

#endif // HERMES_ABI_HERMES_ABI_H

#ifdef __cplusplus
}
#endif
