/// Ferrum FFI Dispatch — generic typed objc_msgSend from ABI values.
/// Resolves the correct dispatch function at registration time (once per method).
/// At call time: single function pointer dereference — same overhead as V1 codegen.

#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>
#import <objc/runtime.h>
#import <objc/message.h>
#include <hermes_abi/hermes_abi.h>
#import "FerrumFFIDispatch.h"
#import "FerrumABIHelpers.h"

// --- Arg kind from ObjC type encoding ---

enum class AKind { Void, Double, Float, Int, LongLong, Bool, Object, Block, Unknown };

static AKind kindFromEncoding(const char *enc) {
  switch (enc[0]) {
    case _C_VOID: return AKind::Void;
    case _C_DBL:  return AKind::Double;
    case _C_FLT:  return AKind::Float;
    case _C_INT:  case _C_UINT: return AKind::Int;
    case _C_LNG:  case _C_ULNG: case _C_LNG_LNG: case _C_ULNG_LNG: return AKind::LongLong;
    case _C_SHT:  case _C_USHT: return AKind::Int;
    case _C_CHR:  case _C_UCHR: case _C_BOOL: return AKind::Bool;
    case _C_ID:
      if (enc[1] == '?') return AKind::Block; // @? = block type
      return AKind::Object;
    case _C_CLASS: return AKind::Object;
    default: return AKind::Unknown;
  }
}

// FerrumDispatchInfo and FerrumCallFn defined in FerrumFFIDispatch.h

// --- Arg extraction helpers ---

static inline double getNum(const HermesABIValue *v) { return v->data.number; }
static inline BOOL getBool(const HermesABIValue *v) { return v->data.boolean; }
static id getObj(HermesABIRuntime *rt, const HermesABIRuntimeVTable *vt, const HermesABIValue *v) {
  if (v->kind == HermesABIValueKindString) return ferrum_abi_get_string(rt, vt, v);
  if (v->kind == HermesABIValueKindNull || v->kind == HermesABIValueKindUndefined) return nil;
  if (v->kind == HermesABIValueKindObject) return ferrum_abi_get_array(rt, vt, v); // arrays are objects
  return nil;
}

// ============================================================================
// Resolved dispatch functions — each handles one specific type pattern.
// At call time: one function pointer dereference, then straight to objc_msgSend.
// ============================================================================

// --- VOID RETURN (dispatch_async) ---

static HermesABIValueOrError ffi_void_0(const FerrumDispatchInfo *i, HermesABIRuntime*, const HermesABIRuntimeVTable*, const HermesABIValue*, size_t) {
  id inst = i->instance; SEL s = i->selector;
  dispatch_async(i->methodQueue, ^{ ((void(*)(id,SEL))objc_msgSend)(inst, s); });
  HermesABIValueOrError r; r.value.kind = HermesABIValueKindUndefined; return r;
}

static HermesABIValueOrError ffi_void_1_double(const FerrumDispatchInfo *i, HermesABIRuntime*, const HermesABIRuntimeVTable*, const HermesABIValue *args, size_t) {
  id inst = i->instance; SEL s = i->selector; double a0 = getNum(&args[0]);
  dispatch_async(i->methodQueue, ^{ ((void(*)(id,SEL,double))objc_msgSend)(inst, s, a0); });
  HermesABIValueOrError r; r.value.kind = HermesABIValueKindUndefined; return r;
}

static HermesABIValueOrError ffi_void_1_bool(const FerrumDispatchInfo *i, HermesABIRuntime*, const HermesABIRuntimeVTable*, const HermesABIValue *args, size_t) {
  id inst = i->instance; SEL s = i->selector; BOOL a0 = getBool(&args[0]);
  dispatch_async(i->methodQueue, ^{ ((void(*)(id,SEL,BOOL))objc_msgSend)(inst, s, a0); });
  HermesABIValueOrError r; r.value.kind = HermesABIValueKindUndefined; return r;
}

static HermesABIValueOrError ffi_void_1_obj(const FerrumDispatchInfo *i, HermesABIRuntime *rt, const HermesABIRuntimeVTable *vt, const HermesABIValue *args, size_t) {
  id inst = i->instance; SEL s = i->selector; id a0 = getObj(rt, vt, &args[0]);
  dispatch_async(i->methodQueue, ^{ ((void(*)(id,SEL,id))objc_msgSend)(inst, s, a0); });
  HermesABIValueOrError r; r.value.kind = HermesABIValueKindUndefined; return r;
}

static HermesABIValueOrError ffi_void_1_int(const FerrumDispatchInfo *i, HermesABIRuntime*, const HermesABIRuntimeVTable*, const HermesABIValue *args, size_t) {
  id inst = i->instance; SEL s = i->selector; int a0 = (int)getNum(&args[0]);
  dispatch_async(i->methodQueue, ^{ ((void(*)(id,SEL,int))objc_msgSend)(inst, s, a0); });
  HermesABIValueOrError r; r.value.kind = HermesABIValueKindUndefined; return r;
}

static HermesABIValueOrError ffi_void_2_double_double(const FerrumDispatchInfo *i, HermesABIRuntime*, const HermesABIRuntimeVTable*, const HermesABIValue *args, size_t) {
  id inst = i->instance; SEL s = i->selector;
  double a0 = getNum(&args[0]), a1 = getNum(&args[1]);
  dispatch_async(i->methodQueue, ^{ ((void(*)(id,SEL,double,double))objc_msgSend)(inst, s, a0, a1); });
  HermesABIValueOrError r; r.value.kind = HermesABIValueKindUndefined; return r;
}

static HermesABIValueOrError ffi_void_2_obj_obj(const FerrumDispatchInfo *i, HermesABIRuntime *rt, const HermesABIRuntimeVTable *vt, const HermesABIValue *args, size_t) {
  id inst = i->instance; SEL s = i->selector;
  id a0 = getObj(rt, vt, &args[0]), a1 = getObj(rt, vt, &args[1]);
  dispatch_async(i->methodQueue, ^{ ((void(*)(id,SEL,id,id))objc_msgSend)(inst, s, a0, a1); });
  HermesABIValueOrError r; r.value.kind = HermesABIValueKindUndefined; return r;
}

static HermesABIValueOrError ffi_void_2_obj_double(const FerrumDispatchInfo *i, HermesABIRuntime *rt, const HermesABIRuntimeVTable *vt, const HermesABIValue *args, size_t) {
  id inst = i->instance; SEL s = i->selector;
  id a0 = getObj(rt, vt, &args[0]); double a1 = getNum(&args[1]);
  dispatch_async(i->methodQueue, ^{ ((void(*)(id,SEL,id,double))objc_msgSend)(inst, s, a0, a1); });
  HermesABIValueOrError r; r.value.kind = HermesABIValueKindUndefined; return r;
}

static HermesABIValueOrError ffi_void_3_obj_obj_obj(const FerrumDispatchInfo *i, HermesABIRuntime *rt, const HermesABIRuntimeVTable *vt, const HermesABIValue *args, size_t) {
  id inst = i->instance; SEL s = i->selector;
  id a0 = getObj(rt, vt, &args[0]), a1 = getObj(rt, vt, &args[1]), a2 = getObj(rt, vt, &args[2]);
  dispatch_async(i->methodQueue, ^{ ((void(*)(id,SEL,id,id,id))objc_msgSend)(inst, s, a0, a1, a2); });
  HermesABIValueOrError r; r.value.kind = HermesABIValueKindUndefined; return r;
}

// --- DOUBLE RETURN (sync) ---

static HermesABIValueOrError ffi_double_0(const FerrumDispatchInfo *i, HermesABIRuntime*, const HermesABIRuntimeVTable*, const HermesABIValue*, size_t) {
  double ret = ((double(*)(id,SEL))objc_msgSend)(i->instance, i->selector);
  HermesABIValueOrError r; r.value.kind = HermesABIValueKindNumber; r.value.data.number = ret; return r;
}

static HermesABIValueOrError ffi_double_1_double(const FerrumDispatchInfo *i, HermesABIRuntime*, const HermesABIRuntimeVTable*, const HermesABIValue *args, size_t) {
  double ret = ((double(*)(id,SEL,double))objc_msgSend)(i->instance, i->selector, getNum(&args[0]));
  HermesABIValueOrError r; r.value.kind = HermesABIValueKindNumber; r.value.data.number = ret; return r;
}

static HermesABIValueOrError ffi_double_2_double_double(const FerrumDispatchInfo *i, HermesABIRuntime*, const HermesABIRuntimeVTable*, const HermesABIValue *args, size_t) {
  double ret = ((double(*)(id,SEL,double,double))objc_msgSend)(i->instance, i->selector, getNum(&args[0]), getNum(&args[1]));
  HermesABIValueOrError r; r.value.kind = HermesABIValueKindNumber; r.value.data.number = ret; return r;
}

// --- BOOL RETURN (sync) ---

static HermesABIValueOrError ffi_bool_0(const FerrumDispatchInfo *i, HermesABIRuntime*, const HermesABIRuntimeVTable*, const HermesABIValue*, size_t) {
  BOOL ret = ((BOOL(*)(id,SEL))objc_msgSend)(i->instance, i->selector);
  HermesABIValueOrError r; r.value.kind = HermesABIValueKindBoolean; r.value.data.boolean = ret; return r;
}

static HermesABIValueOrError ffi_bool_1_bool(const FerrumDispatchInfo *i, HermesABIRuntime*, const HermesABIRuntimeVTable*, const HermesABIValue *args, size_t) {
  BOOL ret = ((BOOL(*)(id,SEL,BOOL))objc_msgSend)(i->instance, i->selector, getBool(&args[0]));
  HermesABIValueOrError r; r.value.kind = HermesABIValueKindBoolean; r.value.data.boolean = ret; return r;
}

// --- OBJECT RETURN (sync) ---

static HermesABIValueOrError ffi_obj_0(const FerrumDispatchInfo *i, HermesABIRuntime *rt, const HermesABIRuntimeVTable *vt, const HermesABIValue*, size_t) {
  id ret = ((id(*)(id,SEL))objc_msgSend)(i->instance, i->selector);
  return ferrum_abi_from_object(rt, vt, ret);
}

static HermesABIValueOrError ffi_obj_1_obj(const FerrumDispatchInfo *i, HermesABIRuntime *rt, const HermesABIRuntimeVTable *vt, const HermesABIValue *args, size_t) {
  id ret = ((id(*)(id,SEL,id))objc_msgSend)(i->instance, i->selector, getObj(rt, vt, &args[0]));
  return ferrum_abi_from_object(rt, vt, ret);
}

static HermesABIValueOrError ffi_obj_1_double(const FerrumDispatchInfo *i, HermesABIRuntime *rt, const HermesABIRuntimeVTable *vt, const HermesABIValue *args, size_t) {
  id ret = ((id(*)(id,SEL,double))objc_msgSend)(i->instance, i->selector, getNum(&args[0]));
  return ferrum_abi_from_object(rt, vt, ret);
}

static HermesABIValueOrError ffi_obj_1_bool(const FerrumDispatchInfo *i, HermesABIRuntime *rt, const HermesABIRuntimeVTable *vt, const HermesABIValue *args, size_t) {
  id ret = ((id(*)(id,SEL,BOOL))objc_msgSend)(i->instance, i->selector, getBool(&args[0]));
  return ferrum_abi_from_object(rt, vt, ret);
}

static HermesABIValueOrError ffi_obj_2_double_double(const FerrumDispatchInfo *i, HermesABIRuntime *rt, const HermesABIRuntimeVTable *vt, const HermesABIValue *args, size_t) {
  id ret = ((id(*)(id,SEL,double,double))objc_msgSend)(i->instance, i->selector, getNum(&args[0]), getNum(&args[1]));
  return ferrum_abi_from_object(rt, vt, ret);
}

static HermesABIValueOrError ffi_obj_2_obj_obj(const FerrumDispatchInfo *i, HermesABIRuntime *rt, const HermesABIRuntimeVTable *vt, const HermesABIValue *args, size_t) {
  id ret = ((id(*)(id,SEL,id,id))objc_msgSend)(i->instance, i->selector, getObj(rt, vt, &args[0]), getObj(rt, vt, &args[1]));
  return ferrum_abi_from_object(rt, vt, ret);
}

// --- INT/LONGLONG RETURN (sync) ---

static HermesABIValueOrError ffi_int_0(const FerrumDispatchInfo *i, HermesABIRuntime*, const HermesABIRuntimeVTable*, const HermesABIValue*, size_t) {
  long long ret = ((long long(*)(id,SEL))objc_msgSend)(i->instance, i->selector);
  HermesABIValueOrError r; r.value.kind = HermesABIValueKindNumber; r.value.data.number = (double)ret; return r;
}

// ============================================================================
// Registration: resolve type encoding → function pointer (once per method)
// ============================================================================

extern "C" {

FerrumDispatchInfo *ferrum_dispatch_build(id instance, SEL selector) {
  Method m = class_getInstanceMethod([instance class], selector);
  if (!m) {
    // JS name → ObjC selector: scan for prefix + ':'
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

  AKind retKind = kindFromEncoding([sig methodReturnType]);
  if (retKind == AKind::Unknown) return nullptr;

  NSUInteger nargs = [sig numberOfArguments] - 2; // skip self, _cmd
  AKind argKinds[4];
  if (nargs > 4) return nullptr; // too many args for our patterns
  for (NSUInteger i = 0; i < nargs; i++) {
    argKinds[i] = kindFromEncoding([sig getArgumentTypeAtIndex:i + 2]);
    if (argKinds[i] == AKind::Unknown) return nullptr;
  }

  // --- Resolve to specific function pointer ---
  FerrumCallFn callFn = nullptr;

  if (retKind == AKind::Void) {
    if (nargs == 0) callFn = ffi_void_0;
    else if (nargs == 1 && argKinds[0] == AKind::Double) callFn = ffi_void_1_double;
    else if (nargs == 1 && argKinds[0] == AKind::Bool)   callFn = ffi_void_1_bool;
    else if (nargs == 1 && argKinds[0] == AKind::Object)  callFn = ffi_void_1_obj;
    else if (nargs == 1 && argKinds[0] == AKind::Int)     callFn = ffi_void_1_int;
    else if (nargs == 2 && argKinds[0] == AKind::Double && argKinds[1] == AKind::Double) callFn = ffi_void_2_double_double;
    else if (nargs == 2 && argKinds[0] == AKind::Object && argKinds[1] == AKind::Object) callFn = ffi_void_2_obj_obj;
    else if (nargs == 2 && argKinds[0] == AKind::Object && argKinds[1] == AKind::Double) callFn = ffi_void_2_obj_double;
    else if (nargs == 3 && argKinds[0] == AKind::Object && argKinds[1] == AKind::Object && argKinds[2] == AKind::Object) callFn = ffi_void_3_obj_obj_obj;
  } else if (retKind == AKind::Double) {
    if (nargs == 0) callFn = ffi_double_0;
    else if (nargs == 1 && argKinds[0] == AKind::Double) callFn = ffi_double_1_double;
    else if (nargs == 2 && argKinds[0] == AKind::Double && argKinds[1] == AKind::Double) callFn = ffi_double_2_double_double;
  } else if (retKind == AKind::Bool) {
    if (nargs == 0) callFn = ffi_bool_0;
    else if (nargs == 1 && argKinds[0] == AKind::Bool) callFn = ffi_bool_1_bool;
  } else if (retKind == AKind::Object) {
    if (nargs == 0) callFn = ffi_obj_0;
    else if (nargs == 1 && argKinds[0] == AKind::Object) callFn = ffi_obj_1_obj;
    else if (nargs == 1 && argKinds[0] == AKind::Double) callFn = ffi_obj_1_double;
    else if (nargs == 1 && argKinds[0] == AKind::Bool)   callFn = ffi_obj_1_bool;
    else if (nargs == 2 && argKinds[0] == AKind::Double && argKinds[1] == AKind::Double) callFn = ffi_obj_2_double_double;
    else if (nargs == 2 && argKinds[0] == AKind::Object && argKinds[1] == AKind::Object) callFn = ffi_obj_2_obj_obj;
  } else if (retKind == AKind::Int || retKind == AKind::LongLong) {
    if (nargs == 0) callFn = ffi_int_0;
  }

  if (!callFn) {
    NSLog(@"[Ferrum FFI] No pattern for %@ (ret=%d, %lu args)",
          NSStringFromSelector(selector), (int)retKind, (unsigned long)nargs);
    return nullptr;
  }

  auto *info = new FerrumDispatchInfo();
  info->instance = instance;
  info->selector = selector;
  info->callFn = callFn;

  if ([instance respondsToSelector:@selector(methodQueue)]) {
    info->methodQueue = [(id<RCTBridgeModule>)instance methodQueue];
  } else {
    info->methodQueue = dispatch_get_main_queue();
  }

  NSLog(@"[Ferrum FFI] Resolved %@ → %p", NSStringFromSelector(selector), (void *)callFn);
  return info;
}

HermesABIValueOrError ferrum_dispatch_call(
    const FerrumDispatchInfo *info,
    HermesABIRuntime *abiRt,
    const HermesABIRuntimeVTable *vt,
    const HermesABIValue *args,
    size_t count) {
  // Single function pointer dereference — resolved at registration time
  return info->callFn(info, abiRt, vt, args, count);
}

void ferrum_dispatch_free(FerrumDispatchInfo *info) {
  delete info;
}

} // extern "C"
