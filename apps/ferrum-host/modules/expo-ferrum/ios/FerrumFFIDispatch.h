/// Ferrum FFI Dispatch — typed objc_msgSend from runtime type encoding.
///
/// At registration time: parse ObjC type encoding → resolve function pointer
/// At call time: single function pointer dereference → typed objc_msgSend

#pragma once

#include <objc/runtime.h>
#include <objc/message.h>
#import <Foundation/Foundation.h>

#ifdef __cplusplus

#include <jsi/jsi.h>

/// Dispatch info — resolved at registration time, one per method.
struct FerrumDispatchInfo {
  id instance;
  SEL selector;
  dispatch_queue_t methodQueue;
  // Resolved call function stored as opaque pointer (type varies by path)
  void *callFn;
  // Arg kinds for JSI dispatch
  unsigned int argCount;
  int argKinds[4]; // AKind values, max 4 args
  int retKind;
};

/// Build dispatch info from ObjC method. Returns NULL if unsupported.
FerrumDispatchInfo *ferrum_dispatch_build(id instance, SEL selector, unsigned int expectedArgs);

/// Call via JSI args — typed objc_msgSend, no NSInvocation.
facebook::jsi::Value ferrum_dispatch_call_jsi(
    const FerrumDispatchInfo *info,
    facebook::jsi::Runtime &rt,
    const facebook::jsi::Value *args,
    size_t count);

void ferrum_dispatch_free(FerrumDispatchInfo *info);

/// Set CallInvoker for async callback dispatch.
void ferrum_dispatch_set_globals(void *invokerPtr);

#endif // __cplusplus
