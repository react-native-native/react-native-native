/// Ferrum FFI Dispatch — generic method invocation from HermesABIValue args
/// using typed objc_msgSend casts. Built once, works for every TurboModule
/// method matching common type encoding patterns.
///
/// At registration time: parse ObjC type encoding → cache dispatch info
/// At call time: convert ABI args → call objc_msgSend directly → convert result
///
/// No NSInvocation. No codegen. No std::function. No libffi.

#pragma once

#include <objc/runtime.h>
#include <objc/message.h>

struct HermesABIValue;
struct HermesABIValueOrError;
struct HermesABIRuntime;
struct HermesABIRuntimeVTable;

#ifdef __cplusplus
extern "C" {
#endif

/// Opaque handle for a cached method dispatch.
typedef struct FerrumDispatchInfo FerrumDispatchInfo;

/// Build a dispatch info from an ObjC method's type encoding.
/// Returns NULL if the encoding pattern is unsupported.
/// The returned info is heap-allocated and should be freed with ferrum_dispatch_free.
FerrumDispatchInfo *ferrum_dispatch_build(
    id instance,
    SEL selector);

/// Invoke a method using the cached dispatch info.
/// Converts HermesABIValue args directly to native types and calls objc_msgSend.
struct HermesABIValueOrError ferrum_dispatch_call(
    const FerrumDispatchInfo *info,
    struct HermesABIRuntime *abiRt,
    const struct HermesABIRuntimeVTable *vt,
    const struct HermesABIValue *args,
    size_t count);

void ferrum_dispatch_free(FerrumDispatchInfo *info);

#ifdef __cplusplus
}
#endif
