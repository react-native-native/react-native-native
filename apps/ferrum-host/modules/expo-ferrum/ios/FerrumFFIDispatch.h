/// Ferrum FFI Dispatch — generic method invocation from HermesABIValue args
/// using typed objc_msgSend casts resolved at registration time.
///
/// At registration time: parse ObjC type encoding → resolve function pointer (once)
/// At call time: single function pointer dereference → typed objc_msgSend

#pragma once

#include <objc/runtime.h>
#include <objc/message.h>
#import <Foundation/Foundation.h>

#ifdef __cplusplus

struct HermesABIValue;
struct HermesABIValueOrError;
struct HermesABIRuntime;
struct HermesABIRuntimeVTable;
struct FerrumDispatchInfo;

/// Resolved call function — one per type pattern, resolved at registration time.
typedef HermesABIValueOrError (*FerrumCallFn)(
    const FerrumDispatchInfo *info,
    HermesABIRuntime *abiRt,
    const HermesABIRuntimeVTable *vt,
    const HermesABIValue *args,
    size_t count);

/// Dispatch info — all fields needed at call time, designed to be inlined
/// into the C ABI host function context (single allocation, no pointer chasing).
struct FerrumDispatchInfo {
  id instance;
  SEL selector;
  dispatch_queue_t methodQueue;
  FerrumCallFn callFn;
};

extern "C" {

FerrumDispatchInfo *ferrum_dispatch_build(id instance, SEL selector);

HermesABIValueOrError ferrum_dispatch_call(
    const FerrumDispatchInfo *info,
    HermesABIRuntime *abiRt,
    const HermesABIRuntimeVTable *vt,
    const HermesABIValue *args,
    size_t count);

void ferrum_dispatch_free(FerrumDispatchInfo *info);

} // extern "C"

#endif // __cplusplus
