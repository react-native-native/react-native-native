/// FerrumFFIDispatch — typed objc_msgSend resolved at module load time.
///
/// Architecture: ARM64 and x86_64 both assign integer-register args and
/// float-register args to independent register banks. Register assignment
/// depends on the COUNT of each type, not their ORDER. We collapse all arg
/// permutations into (N_int, N_double) pairs and resolve to a single function
/// pointer at registration time. Call time is one indirect call.

#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTConvert.h>
#include <ReactCommon/CallInvoker.h>
#import <objc/runtime.h>
#import <objc/message.h>
#include <jsi/jsi.h>
#import "FerrumFFIDispatch.h"

using namespace facebook;

// ---------------------------------------------------------------------------
// Type classification
// ---------------------------------------------------------------------------

enum class AKind { Void, Double, Float, Int, LongLong, Bool, Object, Block, Unknown };

static AKind kindFromEncoding(const char *enc) {
  switch (enc[0]) {
    case _C_VOID: return AKind::Void;
    case _C_DBL:  return AKind::Double;
    case _C_FLT:  return AKind::Float;
    case _C_INT: case _C_UINT: return AKind::Int;
    case _C_LNG: case _C_ULNG: case _C_LNG_LNG: case _C_ULNG_LNG: return AKind::LongLong;
    case _C_SHT: case _C_USHT: return AKind::Int;
    case _C_CHR: case _C_UCHR: case _C_BOOL: return AKind::Bool;
    case _C_ID:   return enc[1] == '?' ? AKind::Block : AKind::Object;
    case _C_CLASS: return AKind::Object;
    default: return AKind::Unknown;
  }
}

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------

static std::shared_ptr<facebook::react::CallInvoker> g_invoker = nullptr;
static jsi::Runtime *g_rtPtr = nullptr;

void ferrum_dispatch_set_globals(void *invokerPtr) {
  if (invokerPtr) {
    auto *ptr = reinterpret_cast<std::shared_ptr<facebook::react::CallInvoker> *>(invokerPtr);
    g_invoker = *ptr;
    delete ptr;
  }
}

void ferrum_dispatch_set_runtime(jsi::Runtime *rt) {
  g_rtPtr = rt;
}

// ---------------------------------------------------------------------------
// JSI ↔ ObjC conversion
// ---------------------------------------------------------------------------

static id jsiToObjC(jsi::Runtime &rt, const jsi::Value &v);

static NSArray *jsiToArray(jsi::Runtime &rt, const jsi::Value &v) {
  if (!v.isObject()) return @[];
  auto obj = v.asObject(rt);
  if (!obj.isArray(rt)) return @[];
  auto arr = obj.asArray(rt);
  size_t len = arr.size(rt);
  NSMutableArray *result = [NSMutableArray arrayWithCapacity:len];
  for (size_t i = 0; i < len; i++) {
    id elem = jsiToObjC(rt, arr.getValueAtIndex(rt, i));
    [result addObject:elem ?: [NSNull null]];
  }
  return result;
}

static NSDictionary *jsiToDict(jsi::Runtime &rt, const jsi::Value &v) {
  if (!v.isObject()) return @{};
  auto obj = v.asObject(rt);
  auto names = obj.getPropertyNames(rt);
  size_t len = names.size(rt);
  NSMutableDictionary *result = [NSMutableDictionary dictionaryWithCapacity:len];
  for (size_t i = 0; i < len; i++) {
    std::string key = names.getValueAtIndex(rt, i).getString(rt).utf8(rt);
    id val = jsiToObjC(rt, obj.getProperty(rt, key.c_str()));
    if (val) result[[NSString stringWithUTF8String:key.c_str()]] = val;
  }
  return result;
}

static id jsiToObjC(jsi::Runtime &rt, const jsi::Value &v) {
  if (v.isUndefined()) return nil;
  if (v.isNull()) return [NSNull null];
  if (v.isBool()) return @(v.getBool());
  if (v.isNumber()) return @(v.getNumber());
  if (v.isString())
    return [NSString stringWithUTF8String:v.getString(rt).utf8(rt).c_str()];
  if (v.isObject()) {
    auto obj = v.asObject(rt);
    if (obj.isArray(rt)) return jsiToArray(rt, v);
    return jsiToDict(rt, v);
  }
  return [NSNull null];
}

static jsi::Value objcToJSI(jsi::Runtime &rt, id obj) {
  if (!obj) return jsi::Value::undefined();
  if ([obj isKindOfClass:[NSNull class]]) return jsi::Value::null();
  if ([obj isKindOfClass:[NSNumber class]]) {
    NSNumber *num = obj;
    const char *type = [num objCType];
    if (type[0] == 'c' || type[0] == 'B')
      return jsi::Value(static_cast<bool>([num boolValue]));
    return jsi::Value([num doubleValue]);
  }
  if ([obj isKindOfClass:[NSString class]])
    return jsi::String::createFromUtf8(rt, [(NSString *)obj UTF8String]);
  if ([obj isKindOfClass:[NSArray class]]) {
    NSArray *arr = obj;
    auto jsArr = jsi::Array(rt, arr.count);
    for (NSUInteger i = 0; i < arr.count; i++)
      jsArr.setValueAtIndex(rt, i, objcToJSI(rt, arr[i]));
    return std::move(jsArr);
  }
  if ([obj isKindOfClass:[NSDictionary class]]) {
    NSDictionary *dict = obj;
    auto jsObj = jsi::Object(rt);
    for (NSString *key in dict)
      jsObj.setProperty(rt, [key UTF8String], objcToJSI(rt, dict[key]));
    return std::move(jsObj);
  }
  return jsi::Value::null();
}

// ---------------------------------------------------------------------------
// Inline arg extraction helpers — no struct, no iteration at call time
// ---------------------------------------------------------------------------

// Convert an id arg, applying the type converter resolved at registration time
static inline id convertObj(jsi::Runtime &rt, const jsi::Value &v,
                            ArgConvert conv, SEL convSel) {
  id obj = jsiToObjC(rt, v);
  switch (conv) {
    case ArgConvert::NSURL:
      if ([obj isKindOfClass:[NSString class]]) return [NSURL URLWithString:obj];
      break;
    case ArgConvert::NSDate:
      if ([obj isKindOfClass:[NSNumber class]])
        return [NSDate dateWithTimeIntervalSince1970:[obj doubleValue] / 1000.0];
      break;
    case ArgConvert::NSData:
      if ([obj isKindOfClass:[NSString class]])
        return [[NSData alloc] initWithBase64EncodedString:obj options:0];
      break;
    case ArgConvert::RCTConvert:
      if (convSel) return [RCTConvert performSelector:convSel withObject:obj];
      break;
    default: break;
  }
  return obj;
}

// Block wrapping: jsi::Function → ObjC callback blocks.
// Single heap allocation (FerrumCB) holds the jsi::Function. The ObjC block
// captures only a raw pointer — trivial copy, no __block overhead, no
// shared_ptr ref counting. Deleted on the JS thread inside invokeAsync.

struct FerrumCB {
  jsi::Function fn;
  FerrumCB(jsi::Function &&f) : fn(std::move(f)) {}
};

static RCTResponseSenderBlock getBlock(jsi::Runtime &rt, const jsi::Value &v) {
  if (!v.isObject()) return ^(NSArray *r) {};
  auto obj = v.asObject(rt);
  if (!obj.isFunction(rt)) return ^(NSArray *r) {};
  auto *cb = new FerrumCB(obj.asFunction(rt));

  return [^(NSArray *response) {
    if (!g_invoker || !g_rtPtr) { delete cb; return; }
    auto *p = cb;
    g_invoker->invokeAsync([p, response]() {
      if (!g_rtPtr) { delete p; return; }
      auto &rt = *g_rtPtr;
      size_t argc = response.count;
      std::vector<jsi::Value> args;
      args.reserve(argc);
      for (size_t i = 0; i < argc; i++)
        args.push_back(objcToJSI(rt, response[i]));
      using CallFn = jsi::Value (jsi::Function::*)(jsi::Runtime &, const jsi::Value *, size_t) const;
      (p->fn.*static_cast<CallFn>(&jsi::Function::call))(
          rt, args.empty() ? nullptr : args.data(), argc);
      delete p;
    });
  } copy];
}

static RCTPromiseResolveBlock getResolveBlock(jsi::Runtime &rt, const jsi::Value &v) {
  if (!v.isObject()) return ^(id r) {};
  auto obj = v.asObject(rt);
  if (!obj.isFunction(rt)) return ^(id r) {};
  auto *cb = new FerrumCB(obj.asFunction(rt));

  return [^(id result) {
    if (!g_invoker || !g_rtPtr) { delete cb; return; }
    auto *p = cb;
    g_invoker->invokeAsync([p, result]() {
      if (!g_rtPtr) { delete p; return; }
      p->fn.call(*g_rtPtr, objcToJSI(*g_rtPtr, result));
      delete p;
    });
  } copy];
}

static RCTPromiseRejectBlock getRejectBlock(jsi::Runtime &rt, const jsi::Value &v) {
  if (!v.isObject()) return ^(NSString *c, NSString *m, NSError *e) {};
  auto obj = v.asObject(rt);
  if (!obj.isFunction(rt)) return ^(NSString *c, NSString *m, NSError *e) {};
  auto *cb = new FerrumCB(obj.asFunction(rt));

  return [^(NSString *code, NSString *message, NSError *error) {
    if (!g_invoker || !g_rtPtr) { delete cb; return; }
    auto *p = cb;
    g_invoker->invokeAsync([p, code, message]() {
      if (!g_rtPtr) { delete p; return; }
      auto &rt = *g_rtPtr;
      auto jsErr = jsi::Object(rt);
      if (code) jsErr.setProperty(rt, "code", jsi::String::createFromUtf8(rt, [code UTF8String]));
      if (message) jsErr.setProperty(rt, "message", jsi::String::createFromUtf8(rt, [message UTF8String]));
      p->fn.call(rt, jsErr);
      delete p;
    });
  } copy];
}

// Extract a single integer-register arg (id, block, bool, int, long long)
// Returns uintptr_t. For ObjC objects/blocks, the raw pointer carries +1 retain
// (via CFBridgingRetain) to prevent ARC from releasing during the cast.
// Callers MUST balance with CFBridgingRelease or __bridge_transfer.
// Value types (Bool/Int/LongLong) have no retain — no cleanup needed.
static inline uintptr_t extractI(jsi::Runtime &rt, const jsi::Value &v,
                                  AKind kind, ArgConvert conv, SEL convSel) {
  switch (kind) {
    case AKind::Object:
      return (uintptr_t)CFBridgingRetain(convertObj(rt, v, conv, convSel));
    case AKind::Block: {
      id blk;
      switch (conv) {
        case ArgConvert::PromiseResolve: blk = getResolveBlock(rt, v); break;
        case ArgConvert::PromiseReject:  blk = getRejectBlock(rt, v); break;
        default:                         blk = getBlock(rt, v); break;
      }
      return (uintptr_t)CFBridgingRetain(blk);
    }
    case AKind::Bool:     return (uintptr_t)(BOOL)v.getBool();
    case AKind::Int:      return (uintptr_t)(int)v.getNumber();
    case AKind::LongLong: return (uintptr_t)(long long)v.getNumber();
    default:              return 0;
  }
}

// ---------------------------------------------------------------------------
// Resolved call functions — one per (retKind, ni, nd) triple
// ---------------------------------------------------------------------------
// Generated at registration time, called at runtime via info->callFn.
// Each function extracts args inline — no DispatchArgs struct, no SIG switch.

// Typed objc_msgSend casts
#define S0(R)      ((R(*)(id,SEL))objc_msgSend)
#define SI(R)      ((R(*)(id,SEL,uintptr_t))objc_msgSend)
#define SD(R)      ((R(*)(id,SEL,double))objc_msgSend)
#define SII(R)     ((R(*)(id,SEL,uintptr_t,uintptr_t))objc_msgSend)
#define SID(R)     ((R(*)(id,SEL,uintptr_t,double))objc_msgSend)
#define SDD(R)     ((R(*)(id,SEL,double,double))objc_msgSend)
#define SIII(R)    ((R(*)(id,SEL,uintptr_t,uintptr_t,uintptr_t))objc_msgSend)
#define SIID(R)    ((R(*)(id,SEL,uintptr_t,uintptr_t,double))objc_msgSend)
#define SIDD(R)    ((R(*)(id,SEL,uintptr_t,double,double))objc_msgSend)
#define SDDD(R)    ((R(*)(id,SEL,double,double,double))objc_msgSend)
#define SIIII(R)   ((R(*)(id,SEL,uintptr_t,uintptr_t,uintptr_t,uintptr_t))objc_msgSend)
#define SIIID(R)   ((R(*)(id,SEL,uintptr_t,uintptr_t,uintptr_t,double))objc_msgSend)
#define SIIDD(R)   ((R(*)(id,SEL,uintptr_t,uintptr_t,double,double))objc_msgSend)
#define SIDDD(R)   ((R(*)(id,SEL,uintptr_t,double,double,double))objc_msgSend)
#define SDDDD(R)   ((R(*)(id,SEL,double,double,double,double))objc_msgSend)

// Macros to extract args inline from JSI values using pre-computed index maps.
// info, rt, args must be in scope. Zero computation — just reads.
#define I(n) extractI(rt, args[info->imap[n]], (AKind)info->argKinds[info->imap[n]], \
    (ArgConvert)info->argConverters[info->imap[n]], info->argConvertSels[info->imap[n]])
#define D(n) args[info->dmap[n]].getNumber()

// For void return, we need ARC-retained captures for id/block args in the async block.
// Extract into __strong id locals before dispatch_async.
#define RETAIN_I(n) __strong id _ri##n = (id)I(n)
#define RI(n) ((uintptr_t)_ri##n)

// --- Void return: dispatch_async with minimal capture ---
// Integer args are uintptr_t for objc_msgSend. ObjC objects (id/block) need
// separate __strong retention to survive until the async block runs.
// Value types (BOOL/int/long long) stay as plain uintptr_t — no ARC.

static inline bool isObjKind(const FerrumDispatchInfo *info, unsigned int iIdx) {
  AKind k = (AKind)info->argKinds[info->imap[iIdx]];
  return k == AKind::Object || k == AKind::Block;
}
// Consumes the +1 retain from extractI via CFBridgingRelease, transfers to __strong.
// For value types: nil — no-op.
#define R(n) (isObjKind(info, n) ? CFBridgingRelease((void *)i##n) : nil)

static jsi::Value call_v_00(const FerrumDispatchInfo *info, jsi::Runtime &, const jsi::Value *, size_t) {
  id inst = info->instance; SEL sel = info->selector;
  dispatch_async(info->methodQueue, ^{ S0(void)(inst, sel); });
  return jsi::Value::undefined();
}
static jsi::Value call_v_10(const FerrumDispatchInfo *info, jsi::Runtime &rt, const jsi::Value *args, size_t) {
  id inst = info->instance; SEL sel = info->selector;
  uintptr_t i0 = I(0); __strong id r0 = R(0);
  dispatch_async(info->methodQueue, ^{ SI(void)(inst, sel, i0); (void)r0; });
  return jsi::Value::undefined();
}
static jsi::Value call_v_01(const FerrumDispatchInfo *info, jsi::Runtime &rt, const jsi::Value *args, size_t) {
  id inst = info->instance; SEL sel = info->selector; double d0 = D(0);
  dispatch_async(info->methodQueue, ^{ SD(void)(inst, sel, d0); });
  return jsi::Value::undefined();
}
static jsi::Value call_v_20(const FerrumDispatchInfo *info, jsi::Runtime &rt, const jsi::Value *args, size_t) {
  id inst = info->instance; SEL sel = info->selector;
  uintptr_t i0 = I(0), i1 = I(1); __strong id r0 = R(0), r1 = R(1);
  dispatch_async(info->methodQueue, ^{ SII(void)(inst, sel, i0, i1); (void)r0; (void)r1; });
  return jsi::Value::undefined();
}
static jsi::Value call_v_11(const FerrumDispatchInfo *info, jsi::Runtime &rt, const jsi::Value *args, size_t) {
  id inst = info->instance; SEL sel = info->selector;
  uintptr_t i0 = I(0); __strong id r0 = R(0); double d0 = D(0);
  dispatch_async(info->methodQueue, ^{ SID(void)(inst, sel, i0, d0); (void)r0; });
  return jsi::Value::undefined();
}
static jsi::Value call_v_02(const FerrumDispatchInfo *info, jsi::Runtime &rt, const jsi::Value *args, size_t) {
  id inst = info->instance; SEL sel = info->selector; double d0 = D(0), d1 = D(1);
  dispatch_async(info->methodQueue, ^{ SDD(void)(inst, sel, d0, d1); });
  return jsi::Value::undefined();
}
static jsi::Value call_v_30(const FerrumDispatchInfo *info, jsi::Runtime &rt, const jsi::Value *args, size_t) {
  id inst = info->instance; SEL sel = info->selector;
  uintptr_t i0 = I(0), i1 = I(1), i2 = I(2); __strong id r0 = R(0), r1 = R(1), r2 = R(2);
  dispatch_async(info->methodQueue, ^{ SIII(void)(inst, sel, i0, i1, i2); (void)r0; (void)r1; (void)r2; });
  return jsi::Value::undefined();
}
static jsi::Value call_v_21(const FerrumDispatchInfo *info, jsi::Runtime &rt, const jsi::Value *args, size_t) {
  id inst = info->instance; SEL sel = info->selector;
  uintptr_t i0 = I(0), i1 = I(1); __strong id r0 = R(0), r1 = R(1); double d0 = D(0);
  dispatch_async(info->methodQueue, ^{ SIID(void)(inst, sel, i0, i1, d0); (void)r0; (void)r1; });
  return jsi::Value::undefined();
}
static jsi::Value call_v_12(const FerrumDispatchInfo *info, jsi::Runtime &rt, const jsi::Value *args, size_t) {
  id inst = info->instance; SEL sel = info->selector;
  uintptr_t i0 = I(0); __strong id r0 = R(0); double d0 = D(0), d1 = D(1);
  dispatch_async(info->methodQueue, ^{ SIDD(void)(inst, sel, i0, d0, d1); (void)r0; });
  return jsi::Value::undefined();
}
static jsi::Value call_v_03(const FerrumDispatchInfo *info, jsi::Runtime &rt, const jsi::Value *args, size_t) {
  id inst = info->instance; SEL sel = info->selector; double d0 = D(0), d1 = D(1), d2 = D(2);
  dispatch_async(info->methodQueue, ^{ SDDD(void)(inst, sel, d0, d1, d2); });
  return jsi::Value::undefined();
}
static jsi::Value call_v_40(const FerrumDispatchInfo *info, jsi::Runtime &rt, const jsi::Value *args, size_t) {
  id inst = info->instance; SEL sel = info->selector;
  uintptr_t i0 = I(0), i1 = I(1), i2 = I(2), i3 = I(3);
  __strong id r0 = R(0), r1 = R(1), r2 = R(2), r3 = R(3);
  dispatch_async(info->methodQueue, ^{ SIIII(void)(inst, sel, i0, i1, i2, i3); (void)r0; (void)r1; (void)r2; (void)r3; });
  return jsi::Value::undefined();
}
static jsi::Value call_v_31(const FerrumDispatchInfo *info, jsi::Runtime &rt, const jsi::Value *args, size_t) {
  id inst = info->instance; SEL sel = info->selector;
  uintptr_t i0 = I(0), i1 = I(1), i2 = I(2); __strong id r0 = R(0), r1 = R(1), r2 = R(2); double d0 = D(0);
  dispatch_async(info->methodQueue, ^{ SIIID(void)(inst, sel, i0, i1, i2, d0); (void)r0; (void)r1; (void)r2; });
  return jsi::Value::undefined();
}
static jsi::Value call_v_22(const FerrumDispatchInfo *info, jsi::Runtime &rt, const jsi::Value *args, size_t) {
  id inst = info->instance; SEL sel = info->selector;
  uintptr_t i0 = I(0), i1 = I(1); __strong id r0 = R(0), r1 = R(1); double d0 = D(0), d1 = D(1);
  dispatch_async(info->methodQueue, ^{ SIIDD(void)(inst, sel, i0, i1, d0, d1); (void)r0; (void)r1; });
  return jsi::Value::undefined();
}
static jsi::Value call_v_13(const FerrumDispatchInfo *info, jsi::Runtime &rt, const jsi::Value *args, size_t) {
  id inst = info->instance; SEL sel = info->selector;
  uintptr_t i0 = I(0); __strong id r0 = R(0); double d0 = D(0), d1 = D(1), d2 = D(2);
  dispatch_async(info->methodQueue, ^{ SIDDD(void)(inst, sel, i0, d0, d1, d2); (void)r0; });
  return jsi::Value::undefined();
}
static jsi::Value call_v_04(const FerrumDispatchInfo *info, jsi::Runtime &rt, const jsi::Value *args, size_t) {
  id inst = info->instance; SEL sel = info->selector; double d0 = D(0), d1 = D(1), d2 = D(2), d3 = D(3);
  dispatch_async(info->methodQueue, ^{ SDDDD(void)(inst, sel, d0, d1, d2, d3); });
  return jsi::Value::undefined();
}

// --- Synchronous return: no dispatch_async, no block capture ---
// I(n) returns +1 retained raw pointers for obj/block. releaseI balances them.
static inline void releaseI(uintptr_t val, const FerrumDispatchInfo *info, unsigned int iIdx) {
  AKind k = (AKind)info->argKinds[info->imap[iIdx]];
  if (k == AKind::Object || k == AKind::Block) CFRelease((void *)val);
}

// Helper macros for sync: extract, call, release, convert.
#define SYNC_EXTRACT_1   uintptr_t _i0 = I(0);
#define SYNC_EXTRACT_2   uintptr_t _i0 = I(0), _i1 = I(1);
#define SYNC_EXTRACT_3   uintptr_t _i0 = I(0), _i1 = I(1), _i2 = I(2);
#define SYNC_EXTRACT_4   uintptr_t _i0 = I(0), _i1 = I(1), _i2 = I(2), _i3 = I(3);
#define SYNC_RELEASE_1   releaseI(_i0, info, 0);
#define SYNC_RELEASE_2   releaseI(_i0, info, 0); releaseI(_i1, info, 1);
#define SYNC_RELEASE_3   releaseI(_i0, info, 0); releaseI(_i1, info, 1); releaseI(_i2, info, 2);
#define SYNC_RELEASE_4   releaseI(_i0, info, 0); releaseI(_i1, info, 1); releaseI(_i2, info, 2); releaseI(_i3, info, 3);

#define SYNC_FN(RNAME, CTYPE, CONVERT)                                          \
static jsi::Value call_##RNAME##_00(const FerrumDispatchInfo *info,             \
    jsi::Runtime &rt, const jsi::Value *, size_t) {                             \
  CTYPE r = S0(CTYPE)(info->instance, info->selector);                         \
  CONVERT                                                                       \
}                                                                               \
static jsi::Value call_##RNAME##_10(const FerrumDispatchInfo *info,             \
    jsi::Runtime &rt, const jsi::Value *args, size_t) {                         \
  SYNC_EXTRACT_1                                                                \
  CTYPE r = SI(CTYPE)(info->instance, info->selector, _i0);                    \
  SYNC_RELEASE_1                                                                \
  CONVERT                                                                       \
}                                                                               \
static jsi::Value call_##RNAME##_01(const FerrumDispatchInfo *info,             \
    jsi::Runtime &rt, const jsi::Value *args, size_t) {                         \
  CTYPE r = SD(CTYPE)(info->instance, info->selector, D(0));                   \
  CONVERT                                                                       \
}                                                                               \
static jsi::Value call_##RNAME##_20(const FerrumDispatchInfo *info,             \
    jsi::Runtime &rt, const jsi::Value *args, size_t) {                         \
  SYNC_EXTRACT_2                                                                \
  CTYPE r = SII(CTYPE)(info->instance, info->selector, _i0, _i1);             \
  SYNC_RELEASE_2                                                                \
  CONVERT                                                                       \
}                                                                               \
static jsi::Value call_##RNAME##_11(const FerrumDispatchInfo *info,             \
    jsi::Runtime &rt, const jsi::Value *args, size_t) {                         \
  SYNC_EXTRACT_1                                                                \
  CTYPE r = SID(CTYPE)(info->instance, info->selector, _i0, D(0));            \
  SYNC_RELEASE_1                                                                \
  CONVERT                                                                       \
}                                                                               \
static jsi::Value call_##RNAME##_02(const FerrumDispatchInfo *info,             \
    jsi::Runtime &rt, const jsi::Value *args, size_t) {                         \
  CTYPE r = SDD(CTYPE)(info->instance, info->selector, D(0), D(1));           \
  CONVERT                                                                       \
}                                                                               \
static jsi::Value call_##RNAME##_30(const FerrumDispatchInfo *info,             \
    jsi::Runtime &rt, const jsi::Value *args, size_t) {                         \
  SYNC_EXTRACT_3                                                                \
  CTYPE r = SIII(CTYPE)(info->instance, info->selector, _i0, _i1, _i2);       \
  SYNC_RELEASE_3                                                                \
  CONVERT                                                                       \
}                                                                               \
static jsi::Value call_##RNAME##_21(const FerrumDispatchInfo *info,             \
    jsi::Runtime &rt, const jsi::Value *args, size_t) {                         \
  SYNC_EXTRACT_2                                                                \
  CTYPE r = SIID(CTYPE)(info->instance, info->selector, _i0, _i1, D(0));      \
  SYNC_RELEASE_2                                                                \
  CONVERT                                                                       \
}                                                                               \
static jsi::Value call_##RNAME##_12(const FerrumDispatchInfo *info,             \
    jsi::Runtime &rt, const jsi::Value *args, size_t) {                         \
  SYNC_EXTRACT_1                                                                \
  CTYPE r = SIDD(CTYPE)(info->instance, info->selector, _i0, D(0), D(1));     \
  SYNC_RELEASE_1                                                                \
  CONVERT                                                                       \
}                                                                               \
static jsi::Value call_##RNAME##_03(const FerrumDispatchInfo *info,             \
    jsi::Runtime &rt, const jsi::Value *args, size_t) {                         \
  CTYPE r = SDDD(CTYPE)(info->instance, info->selector, D(0), D(1), D(2));    \
  CONVERT                                                                       \
}                                                                               \
static jsi::Value call_##RNAME##_40(const FerrumDispatchInfo *info,             \
    jsi::Runtime &rt, const jsi::Value *args, size_t) {                         \
  SYNC_EXTRACT_4                                                                \
  CTYPE r = SIIII(CTYPE)(info->instance, info->selector, _i0, _i1, _i2, _i3); \
  SYNC_RELEASE_4                                                                \
  CONVERT                                                                       \
}                                                                               \
static jsi::Value call_##RNAME##_31(const FerrumDispatchInfo *info,             \
    jsi::Runtime &rt, const jsi::Value *args, size_t) {                         \
  SYNC_EXTRACT_3                                                                \
  CTYPE r = SIIID(CTYPE)(info->instance, info->selector, _i0, _i1, _i2, D(0));\
  SYNC_RELEASE_3                                                                \
  CONVERT                                                                       \
}                                                                               \
static jsi::Value call_##RNAME##_22(const FerrumDispatchInfo *info,             \
    jsi::Runtime &rt, const jsi::Value *args, size_t) {                         \
  SYNC_EXTRACT_2                                                                \
  CTYPE r = SIIDD(CTYPE)(info->instance, info->selector, _i0, _i1, D(0), D(1));\
  SYNC_RELEASE_2                                                                \
  CONVERT                                                                       \
}                                                                               \
static jsi::Value call_##RNAME##_13(const FerrumDispatchInfo *info,             \
    jsi::Runtime &rt, const jsi::Value *args, size_t) {                         \
  SYNC_EXTRACT_1                                                                \
  CTYPE r = SIDDD(CTYPE)(info->instance, info->selector, _i0, D(0), D(1), D(2));\
  SYNC_RELEASE_1                                                                \
  CONVERT                                                                       \
}                                                                               \
static jsi::Value call_##RNAME##_04(const FerrumDispatchInfo *info,             \
    jsi::Runtime &rt, const jsi::Value *args, size_t) {                         \
  CTYPE r = SDDDD(CTYPE)(info->instance, info->selector, D(0), D(1), D(2), D(3));\
  CONVERT                                                                       \
}

// Generate sync return functions
SYNC_FN(d, double, return jsi::Value(r);)
SYNC_FN(b, BOOL,   return jsi::Value(static_cast<bool>(r));)
SYNC_FN(i, long long, return jsi::Value(static_cast<double>(r));)
SYNC_FN(o, id,
  if (!r) return jsi::Value::null();
  if ([r isKindOfClass:[NSNumber class]]) return jsi::Value([r doubleValue]);
  return objcToJSI(rt, r);
)

// ---------------------------------------------------------------------------
// Lookup table: resolve (retKind, ni, nd) → function pointer at registration
// ---------------------------------------------------------------------------

#define SIG(ni, nd) (((ni) << 4) | (nd))

#define FN_TABLE(RNAME) {                             \
  { SIG(0,0), call_##RNAME##_00 },                   \
  { SIG(1,0), call_##RNAME##_10 },                   \
  { SIG(0,1), call_##RNAME##_01 },                   \
  { SIG(2,0), call_##RNAME##_20 },                   \
  { SIG(1,1), call_##RNAME##_11 },                   \
  { SIG(0,2), call_##RNAME##_02 },                   \
  { SIG(3,0), call_##RNAME##_30 },                   \
  { SIG(2,1), call_##RNAME##_21 },                   \
  { SIG(1,2), call_##RNAME##_12 },                   \
  { SIG(0,3), call_##RNAME##_03 },                   \
  { SIG(4,0), call_##RNAME##_40 },                   \
  { SIG(3,1), call_##RNAME##_31 },                   \
  { SIG(2,2), call_##RNAME##_22 },                   \
  { SIG(1,3), call_##RNAME##_13 },                   \
  { SIG(0,4), call_##RNAME##_04 },                   \
}

struct SigEntry { int sig; FerrumCallFn fn; };

static const SigEntry voidTable[]   = FN_TABLE(v);
static const SigEntry doubleTable[] = FN_TABLE(d);
static const SigEntry boolTable[]   = FN_TABLE(b);
static const SigEntry intTable[]    = FN_TABLE(i);
static const SigEntry objTable[]    = FN_TABLE(o);

static FerrumCallFn resolveCallFn(AKind retKind, unsigned int ni, unsigned int nd) {
  int sig = SIG(ni, nd);
  const SigEntry *table;
  size_t count;

  switch (retKind) {
    case AKind::Void:     table = voidTable;   count = 15; break;
    case AKind::Double:   table = doubleTable; count = 15; break;
    case AKind::Bool:     table = boolTable;   count = 15; break;
    case AKind::Int:
    case AKind::LongLong: table = intTable;    count = 15; break;
    case AKind::Object:   table = objTable;    count = 15; break;
    default: return nullptr;
  }

  for (size_t i = 0; i < count; i++) {
    if (table[i].sig == sig) return table[i].fn;
  }
  return nullptr;
}

// ---------------------------------------------------------------------------
// Arg converter resolution
// ---------------------------------------------------------------------------

static NSArray<NSString *> *parseArgTypes(NSString *objcName) {
  NSMutableArray *types = [NSMutableArray array];
  NSRegularExpression *regex =
      [NSRegularExpression regularExpressionWithPattern:@":\\s*\\(([^)]+)\\)"
                                               options:0 error:nil];
  NSArray *matches = [regex matchesInString:objcName options:0
                                      range:NSMakeRange(0, objcName.length)];
  for (NSTextCheckingResult *match in matches) {
    NSString *raw = [objcName substringWithRange:[match rangeAtIndex:1]];
    raw = [raw stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
    raw = [raw stringByReplacingOccurrencesOfString:@"__unused " withString:@""];
    raw = [raw stringByReplacingOccurrencesOfString:@"__nullable " withString:@""];
    raw = [raw stringByReplacingOccurrencesOfString:@"__nonnull " withString:@""];
    raw = [raw stringByReplacingOccurrencesOfString:@" *" withString:@""];
    raw = [raw stringByReplacingOccurrencesOfString:@"*" withString:@""];
    raw = [raw stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
    [types addObject:raw];
  }
  return types;
}

static NSString *selectorFromObjcName(NSString *objcName) {
  NSRegularExpression *parenRegex =
      [NSRegularExpression regularExpressionWithPattern:@"\\([^)]*\\)" options:0 error:nil];
  NSString *stripped = [parenRegex stringByReplacingMatchesInString:objcName
      options:0 range:NSMakeRange(0, objcName.length) withTemplate:@""];
  NSArray *parts = [stripped componentsSeparatedByString:@":"];
  NSMutableString *sel = [NSMutableString string];
  for (NSUInteger i = 0; i < parts.count; i++) {
    NSString *part = [parts[i] stringByTrimmingCharactersInSet:
        [NSCharacterSet whitespaceAndNewlineCharacterSet]];
    if (i == 0) {
      [sel appendString:part];
    } else if (i < parts.count - 1) {
      NSArray *words = [part componentsSeparatedByString:@" "];
      NSString *keyword = [[words lastObject] stringByTrimmingCharactersInSet:
          [NSCharacterSet whitespaceAndNewlineCharacterSet]];
      if (keyword.length > 0) [sel appendString:keyword];
    }
    if (i < parts.count - 1) [sel appendString:@":"];
  }
  return sel;
}

static NSString *findExportObjcName(Class cls, SEL targetSel) {
  NSString *targetName = NSStringFromSelector(targetSel);
  unsigned int count = 0;
  Method *methods = class_copyMethodList(object_getClass(cls), &count);
  NSString *result = nil;
  for (unsigned int i = 0; i < count && !result; i++) {
    NSString *name = NSStringFromSelector(method_getName(methods[i]));
    if (![name hasPrefix:@"__rct_export__"]) continue;
    const RCTMethodInfo *info =
        ((const RCTMethodInfo *(*)(id, SEL))method_getImplementation(methods[i]))(cls, method_getName(methods[i]));
    if (!info || !info->objcName) continue;
    NSString *objcName = [NSString stringWithUTF8String:info->objcName];
    NSString *extractedSel = selectorFromObjcName(objcName);
    if ([extractedSel isEqualToString:targetName])
      result = objcName;
  }
  free(methods);
  return result;
}

static void resolveConverter(NSString *typeName, int *outConverter, SEL *outSel) {
  *outConverter = (int)ArgConvert::None;
  *outSel = nil;

  if ([typeName isEqualToString:@"RCTPromiseResolveBlock"]) {
    *outConverter = (int)ArgConvert::PromiseResolve; return;
  }
  if ([typeName isEqualToString:@"RCTPromiseRejectBlock"]) {
    *outConverter = (int)ArgConvert::PromiseReject; return;
  }

  static NSSet *passthrough = nil;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    passthrough = [NSSet setWithObjects:
      @"NSString", @"NSNumber", @"NSArray", @"NSDictionary",
      @"id", @"NSObject",
      @"RCTResponseSenderBlock", @"RCTResponseErrorBlock", nil];
  });
  if ([passthrough containsObject:typeName]) return;

  if ([typeName isEqualToString:@"NSURL"])   { *outConverter = (int)ArgConvert::NSURL; return; }
  if ([typeName isEqualToString:@"NSDate"])  { *outConverter = (int)ArgConvert::NSDate; return; }
  if ([typeName isEqualToString:@"NSData"])  { *outConverter = (int)ArgConvert::NSData; return; }

  SEL convertSel = NSSelectorFromString([typeName stringByAppendingString:@":"]);
  if ([RCTConvert respondsToSelector:convertSel]) {
    *outConverter = (int)ArgConvert::RCTConvert;
    *outSel = convertSel;
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

FerrumDispatchInfo *ferrum_dispatch_build(id instance, SEL selector, unsigned int expectedArgs) {
  Method m = class_getInstanceMethod([instance class], selector);

  if (m && expectedArgs > 0) {
    NSMethodSignature *sig = [instance methodSignatureForSelector:selector];
    if (sig && [sig numberOfArguments] - 2 != expectedArgs)
      m = nullptr;
  }

  if (!m) {
    NSString *selName = NSStringFromSelector(selector);
    NSString *prefix = [selName stringByAppendingString:@":"];
    Class cls = [instance class];
    while (cls && !m) {
      unsigned int mc = 0;
      Method *methods = class_copyMethodList(cls, &mc);
      for (unsigned int i = 0; i < mc; i++) {
        NSString *name = NSStringFromSelector(method_getName(methods[i]));
        if ([name hasPrefix:prefix]) { m = methods[i]; selector = method_getName(m); break; }
      }
      free(methods);
      cls = class_getSuperclass(cls);
    }
    if (!m) return nullptr;
  }

  NSMethodSignature *sig = [instance methodSignatureForSelector:selector];
  if (!sig) return nullptr;

  AKind retKind = kindFromEncoding([sig methodReturnType]);
  if (retKind == AKind::Unknown || retKind == AKind::Float) return nullptr;

  NSUInteger nargs = [sig numberOfArguments] - 2;
  if (nargs > 4) return nullptr;

  AKind argKinds[4];
  unsigned int imap[4] = {}, dmap[4] = {}, ni = 0, nd = 0;
  for (NSUInteger i = 0; i < nargs; i++) {
    argKinds[i] = kindFromEncoding([sig getArgumentTypeAtIndex:i + 2]);
    if (argKinds[i] == AKind::Unknown || argKinds[i] == AKind::Float) return nullptr;
    if (argKinds[i] == AKind::Double) dmap[nd++] = (unsigned int)i;
    else imap[ni++] = (unsigned int)i;
  }

  // Resolve call function at registration time — no dispatch at call time
  FerrumCallFn callFn = resolveCallFn(retKind, ni, nd);
  if (!callFn) return nullptr;

  // Resolve arg converters
  int argConverters[4] = {};
  SEL argConvertSels[4] = {};
  NSString *objcName = findExportObjcName([instance class], selector);
  if (objcName) {
    NSArray<NSString *> *typeNames = parseArgTypes(objcName);
    for (NSUInteger i = 0; i < nargs && i < typeNames.count; i++) {
      if (argKinds[i] == AKind::Object || argKinds[i] == AKind::Block)
        resolveConverter(typeNames[i], &argConverters[i], &argConvertSels[i]);
    }
  }

  auto *info = new FerrumDispatchInfo();
  info->instance = instance;
  info->selector = selector;
  info->callFn = callFn;
  info->retKind = (int)retKind;
  info->argCount = (unsigned int)nargs;
  for (unsigned int i = 0; i < 4; i++) {
    info->imap[i] = imap[i];
    info->dmap[i] = dmap[i];
  }
  for (unsigned int i = 0; i < nargs; i++) {
    info->argKinds[i] = (int)argKinds[i];
    info->argConverters[i] = argConverters[i];
    info->argConvertSels[i] = argConvertSels[i];
  }

  if ([instance respondsToSelector:@selector(methodQueue)])
    info->methodQueue = [(id<RCTBridgeModule>)instance methodQueue];
  else
    info->methodQueue = dispatch_get_main_queue();

  return info;
}

void ferrum_dispatch_free(FerrumDispatchInfo *info) {
  delete info;
}
