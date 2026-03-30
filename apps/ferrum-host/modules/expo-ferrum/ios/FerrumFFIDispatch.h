/// FerrumFFIDispatch — typed objc_msgSend resolved at module load time.
///
/// Registration: parse type encoding → resolve to a single function pointer.
/// Call time: one indirect call → inline arg extraction → typed objc_msgSend.

#pragma once

#include <objc/runtime.h>
#include <objc/message.h>
#import <Foundation/Foundation.h>

#ifdef __cplusplus

#include <jsi/jsi.h>

/// Arg conversion resolved at registration time.
enum class ArgConvert : int {
  None = 0,
  NSURL,
  NSDate,
  NSData,
  PromiseResolve,
  PromiseReject,
  RCTConvert,
};

struct FerrumDispatchInfo;

/// Pre-resolved call function — one per method, determined at registration time.
typedef facebook::jsi::Value (*FerrumCallFn)(
    const FerrumDispatchInfo *info,
    facebook::jsi::Runtime &rt,
    const facebook::jsi::Value *args,
    size_t count);

/// Dispatch info — resolved once per method at module discovery time.
/// Call time reads only: callFn, instance, selector, methodQueue, imap, dmap,
/// argKinds, argConverters, argConvertSels. All pre-computed. Zero dispatch overhead.
struct FerrumDispatchInfo {
  id instance;
  SEL selector;
  dispatch_queue_t methodQueue;
  FerrumCallFn callFn;          // pre-resolved function pointer
  unsigned int argCount;
  unsigned int imap[4];         // arg indices for integer-register args (pre-computed)
  unsigned int dmap[4];         // arg indices for double args (pre-computed)
  int argKinds[4];
  int argConverters[4];
  SEL argConvertSels[4];
  int retKind;
};

/// Build dispatch info from ObjC method. Returns NULL if unsupported signature.
FerrumDispatchInfo *ferrum_dispatch_build(id instance, SEL selector, unsigned int expectedArgs);

/// Call via JSI args — single indirect call to pre-resolved function.
inline facebook::jsi::Value ferrum_dispatch_call_jsi(
    const FerrumDispatchInfo *info,
    facebook::jsi::Runtime &rt,
    const facebook::jsi::Value *args,
    size_t count) {
  return info->callFn(info, rt, args, count);
}

void ferrum_dispatch_free(FerrumDispatchInfo *info);
void ferrum_dispatch_set_globals(void *invokerPtr);
void ferrum_dispatch_set_runtime(facebook::jsi::Runtime *rt);

#endif
