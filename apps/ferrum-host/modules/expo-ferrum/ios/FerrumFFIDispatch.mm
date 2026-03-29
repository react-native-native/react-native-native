/// Ferrum FFI Dispatch — generic typed objc_msgSend from ABI values.
/// Uses ObjC runtime type encoding constants (_C_DBL, _C_ID, etc.)
/// to match the patterns in RCTModuleMethod.mm.

#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>
#import <objc/runtime.h>
#import <objc/message.h>
#include <hermes_abi/hermes_abi.h>
#import "FerrumFFIDispatch.h"
#import "FerrumABIHelpers.h"
#include <vector>

// Simplified arg/return kind using ObjC encoding constants
enum class AKind { Void, Double, Float, Int, LongLong, Bool, Object, Unknown };

static AKind kindFromEncoding(const char *enc) {
  switch (enc[0]) {
    case _C_VOID: return AKind::Void;
    case _C_DBL:  return AKind::Double;
    case _C_FLT:  return AKind::Float;
    case _C_INT:  case _C_UINT: return AKind::Int;
    case _C_LNG:  case _C_ULNG: return AKind::LongLong;
    case _C_LNG_LNG: case _C_ULNG_LNG: return AKind::LongLong;
    case _C_SHT:  case _C_USHT: return AKind::Int;
    case _C_CHR:  case _C_UCHR: return AKind::Bool; // BOOL on some archs
    case _C_BOOL: return AKind::Bool;
    case _C_ID:   return AKind::Object;
    case _C_CLASS: return AKind::Object;
    default:      return AKind::Unknown;
  }
}

struct FerrumDispatchInfo {
  id instance;
  SEL selector;
  IMP imp;
  AKind retKind;
  std::vector<AKind> argKinds; // excludes self and _cmd
  dispatch_queue_t methodQueue; // module's preferred queue (nil = sync on caller)
};

extern "C" {

FerrumDispatchInfo *ferrum_dispatch_build(id instance, SEL selector) {
  Method m = class_getInstanceMethod([instance class], selector);
  if (!m) {
    // JS method name → ObjC selector: scan for matching prefix + ':'
    NSString *selName = NSStringFromSelector(selector);
    NSString *prefix = [selName stringByAppendingString:@":"];
    unsigned int methodCount = 0;
    Method *methods = class_copyMethodList([instance class], &methodCount);
    for (unsigned int i = 0; i < methodCount; i++) {
      NSString *name = NSStringFromSelector(method_getName(methods[i]));
      if ([name hasPrefix:prefix]) {
        m = methods[i];
        selector = method_getName(m);
        break;
      }
    }
    free(methods);
    if (!m) return nullptr;
  }

  NSMethodSignature *sig = [instance methodSignatureForSelector:selector];
  if (!sig) return nullptr;

  // Parse return type
  AKind retKind = kindFromEncoding([sig methodReturnType]);
  if (retKind == AKind::Unknown) return nullptr;

  // Parse argument types (skip self=0 and _cmd=1)
  std::vector<AKind> argKinds;
  for (NSUInteger i = 2; i < [sig numberOfArguments]; i++) {
    AKind ak = kindFromEncoding([sig getArgumentTypeAtIndex:i]);
    if (ak == AKind::Unknown) return nullptr;
    argKinds.push_back(ak);
  }

  auto *info = new FerrumDispatchInfo();
  info->instance = instance;
  info->selector = selector;
  info->imp = method_getImplementation(m);
  info->retKind = retKind;
  info->argKinds = std::move(argKinds);

  // Get module's method queue for async dispatch (void methods)
  if ([instance respondsToSelector:@selector(methodQueue)]) {
    info->methodQueue = [(id<RCTBridgeModule>)instance methodQueue];
  } else {
    info->methodQueue = dispatch_get_main_queue();
  }

  NSLog(@"[Ferrum FFI] Built dispatch for %@ (ret=%d, %lu args)",
        NSStringFromSelector(selector), (int)retKind, (unsigned long)info->argKinds.size());
  return info;
}

// --- Helpers to extract args from HermesABIValue ---

static inline double getNum(const HermesABIValue *v) { return v->data.number; }
static inline BOOL getBool(const HermesABIValue *v) { return v->data.boolean; }

static id getObj(HermesABIRuntime *rt, const HermesABIRuntimeVTable *vt,
                 const HermesABIValue *v) {
  if (v->kind == HermesABIValueKindString)
    return ferrum_abi_get_string(rt, vt, v);
  if (v->kind == HermesABIValueKindObject)
    return (__bridge id)v->data.pointer; // pass-through for now
  if (v->kind == HermesABIValueKindNull || v->kind == HermesABIValueKindUndefined)
    return nil;
  return nil;
}

static HermesABIValueOrError makeUnsupported(SEL s, AKind retKind, size_t n) {
  NSLog(@"[Ferrum FFI] Unsupported: %@ (ret=%d, %lu args)",
        NSStringFromSelector(s), (int)retKind, (unsigned long)n);
  HermesABIValueOrError r;
  r.value.kind = HermesABIValueKindUndefined;
  return r;
}

#define UNSUPPORTED return makeUnsupported(_sel, info->retKind, nargs)

HermesABIValueOrError ferrum_dispatch_call(
    const FerrumDispatchInfo *info,
    HermesABIRuntime *abiRt,
    const HermesABIRuntimeVTable *vt,
    const HermesABIValue *args,
    size_t count) {

  id _instance = info->instance;
  SEL _sel = info->selector;
  size_t nargs = info->argKinds.size();
  HermesABIValueOrError result;

  // --- VOID RETURN ---
  // Dispatch to module's methodQueue (matches RN's invokeObjCMethod behavior)
  if (info->retKind == AKind::Void) {
    dispatch_queue_t queue = info->methodQueue;
    if (nargs == 0) {
      dispatch_async(queue, ^{ ((void(*)(id, SEL))objc_msgSend)(_instance, _sel); });
    } else if (nargs == 1) {
      auto k = info->argKinds[0];
      if (k == AKind::Double) {
        double a0 = getNum(&args[0]);
        dispatch_async(queue, ^{ ((void(*)(id, SEL, double))objc_msgSend)(_instance, _sel, a0); });
      } else if (k == AKind::Bool) {
        BOOL a0 = getBool(&args[0]);
        dispatch_async(queue, ^{ ((void(*)(id, SEL, BOOL))objc_msgSend)(_instance, _sel, a0); });
      } else if (k == AKind::Object) {
        id a0 = getObj(abiRt, vt, &args[0]);
        dispatch_async(queue, ^{ ((void(*)(id, SEL, id))objc_msgSend)(_instance, _sel, a0); });
      } else if (k == AKind::Int) {
        int a0 = (int)getNum(&args[0]);
        dispatch_async(queue, ^{ ((void(*)(id, SEL, int))objc_msgSend)(_instance, _sel, a0); });
      } else UNSUPPORTED;
    } else if (nargs == 2) {
      auto k0 = info->argKinds[0], k1 = info->argKinds[1];
      if (k0 == AKind::Double && k1 == AKind::Double) {
        double a0 = getNum(&args[0]), a1 = getNum(&args[1]);
        dispatch_async(queue, ^{ ((void(*)(id, SEL, double, double))objc_msgSend)(_instance, _sel, a0, a1); });
      } else if (k0 == AKind::Object && k1 == AKind::Object) {
        id a0 = getObj(abiRt, vt, &args[0]), a1 = getObj(abiRt, vt, &args[1]);
        dispatch_async(queue, ^{ ((void(*)(id, SEL, id, id))objc_msgSend)(_instance, _sel, a0, a1); });
      } else if (k0 == AKind::Object && k1 == AKind::Double) {
        id a0 = getObj(abiRt, vt, &args[0]); double a1 = getNum(&args[1]);
        dispatch_async(queue, ^{ ((void(*)(id, SEL, id, double))objc_msgSend)(_instance, _sel, a0, a1); });
      } else if (k0 == AKind::Double && k1 == AKind::Object) {
        double a0 = getNum(&args[0]); id a1 = getObj(abiRt, vt, &args[1]);
        dispatch_async(queue, ^{ ((void(*)(id, SEL, double, id))objc_msgSend)(_instance, _sel, a0, a1); });
      } else UNSUPPORTED;
    } else if (nargs == 3) {
      auto k0 = info->argKinds[0], k1 = info->argKinds[1], k2 = info->argKinds[2];
      if (k0 == AKind::Object && k1 == AKind::Object && k2 == AKind::Object) {
        id a0 = getObj(abiRt, vt, &args[0]), a1 = getObj(abiRt, vt, &args[1]), a2 = getObj(abiRt, vt, &args[2]);
        dispatch_async(queue, ^{ ((void(*)(id, SEL, id, id, id))objc_msgSend)(_instance, _sel, a0, a1, a2); });
      } else UNSUPPORTED;
    } else UNSUPPORTED;
    result.value.kind = HermesABIValueKindUndefined;
    return result;
  }

  // --- DOUBLE RETURN ---
  if (info->retKind == AKind::Double) {
    double ret;
    switch (nargs) {
    case 0:
      ret = ((double(*)(id, SEL))objc_msgSend)(_instance, _sel);
      break;
    case 1:
      if (info->argKinds[0] == AKind::Double)
        ret = ((double(*)(id, SEL, double))objc_msgSend)(_instance, _sel, getNum(&args[0]));
      else UNSUPPORTED;
      break;
    case 2:
      if (info->argKinds[0] == AKind::Double && info->argKinds[1] == AKind::Double)
        ret = ((double(*)(id, SEL, double, double))objc_msgSend)(_instance, _sel, getNum(&args[0]), getNum(&args[1]));
      else UNSUPPORTED;
      break;
    default: UNSUPPORTED;
    }
    result.value.kind = HermesABIValueKindNumber;
    result.value.data.number = ret;
    return result;
  }

  // --- BOOL RETURN ---
  if (info->retKind == AKind::Bool) {
    BOOL ret;
    switch (nargs) {
    case 0:
      ret = ((BOOL(*)(id, SEL))objc_msgSend)(_instance, _sel);
      break;
    case 1:
      if (info->argKinds[0] == AKind::Bool)
        ret = ((BOOL(*)(id, SEL, BOOL))objc_msgSend)(_instance, _sel, getBool(&args[0]));
      else if (info->argKinds[0] == AKind::Double)
        ret = ((BOOL(*)(id, SEL, double))objc_msgSend)(_instance, _sel, getNum(&args[0]));
      else UNSUPPORTED;
      break;
    default: UNSUPPORTED;
    }
    result.value.kind = HermesABIValueKindBoolean;
    result.value.data.boolean = ret;
    return result;
  }

  // --- OBJECT RETURN (NSNumber*, NSString*, NSDictionary*, etc.) ---
  if (info->retKind == AKind::Object) {
    id ret;
    switch (nargs) {
    case 0:
      ret = ((id(*)(id, SEL))objc_msgSend)(_instance, _sel);
      break;
    case 1:
      if (info->argKinds[0] == AKind::Object)
        ret = ((id(*)(id, SEL, id))objc_msgSend)(_instance, _sel, getObj(abiRt, vt, &args[0]));
      else if (info->argKinds[0] == AKind::Double)
        ret = ((id(*)(id, SEL, double))objc_msgSend)(_instance, _sel, getNum(&args[0]));
      else if (info->argKinds[0] == AKind::Bool)
        ret = ((id(*)(id, SEL, BOOL))objc_msgSend)(_instance, _sel, getBool(&args[0]));
      else UNSUPPORTED;
      break;
    case 2:
      if (info->argKinds[0] == AKind::Double && info->argKinds[1] == AKind::Double)
        ret = ((id(*)(id, SEL, double, double))objc_msgSend)(_instance, _sel, getNum(&args[0]), getNum(&args[1]));
      else if (info->argKinds[0] == AKind::Object && info->argKinds[1] == AKind::Object)
        ret = ((id(*)(id, SEL, id, id))objc_msgSend)(_instance, _sel, getObj(abiRt, vt, &args[0]), getObj(abiRt, vt, &args[1]));
      else UNSUPPORTED;
      break;
    default: UNSUPPORTED;
    }
    // Convert ObjC result to ABI
    return ferrum_abi_from_object(abiRt, vt, ret);
  }

  // --- INT/LONGLONG RETURN ---
  if (info->retKind == AKind::Int || info->retKind == AKind::LongLong) {
    long long ret;
    switch (nargs) {
    case 0:
      ret = ((long long(*)(id, SEL))objc_msgSend)(_instance, _sel);
      break;
    default: UNSUPPORTED;
    }
    result.value.kind = HermesABIValueKindNumber;
    result.value.data.number = (double)ret;
    return result;
  }

  UNSUPPORTED;
}

void ferrum_dispatch_free(FerrumDispatchInfo *info) {
  delete info;
}

} // extern "C"
