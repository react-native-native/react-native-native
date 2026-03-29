#pragma once

// This header is C-only for module map compatibility.
// The C++ implementation lives in FerrumRuntimeFactory.mm.

#ifdef __cplusplus
extern "C" {
#endif

/// Create a FerrumRuntimeFactory as a JSRuntimeFactoryRef (void*).
/// Replaces jsrt_create_hermes_factory() — same type, Ferrum's factory.
void *jsrt_create_ferrum_factory(void);

/// Register Rust-backed JS globals on a raw Hermes C ABI runtime.
/// Called from FerrumRuntimeFactory before the runtime is wrapped in JSI.
void ferrum_register_globals(void *rt, const void *vt);

/// Install __ferrumGetModule on the global — parallel C ABI module getter.
/// Called after the JSI runtime is ready and __turboModuleProxy exists.
void ferrum_install_abi_module_getter(void *rt);

#ifdef __cplusplus
}
#endif
