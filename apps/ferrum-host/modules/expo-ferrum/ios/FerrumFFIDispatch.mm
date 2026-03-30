/// Ferrum FFI Dispatch — typed objc_msgSend from ObjC runtime type info.
/// Pure JSI path: no C ABI, no vendored Hermes.

#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>
#include <ReactCommon/CallInvoker.h>
#import <objc/runtime.h>
#import <objc/message.h>
#include <jsi/jsi.h>
#import "FerrumFFIDispatch.h"

using namespace facebook;

// --- Arg kind enum ---

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
    case _C_ID:
      if (enc[1] == '?') return AKind::Block;
      return AKind::Object;
    case _C_CLASS: return AKind::Object;
    default: return AKind::Unknown;
  }
}

// --- Global CallInvoker for async callbacks ---

static std::shared_ptr<facebook::react::CallInvoker> *g_invoker = nullptr;

void ferrum_dispatch_set_globals(void *invokerPtr) {
  if (invokerPtr)
    g_invoker = reinterpret_cast<std::shared_ptr<facebook::react::CallInvoker> *>(invokerPtr);
}

// --- JSI arg extraction helpers ---

static inline double getNum(const jsi::Value &v) { return v.getNumber(); }
static inline bool getBool(const jsi::Value &v) { return v.getBool(); }
static NSString *getStr(jsi::Runtime &rt, const jsi::Value &v) {
  if (v.isString()) return [NSString stringWithUTF8String:v.getString(rt).utf8(rt).c_str()];
  return nil;
}
static id jsiToObjC(jsi::Runtime &rt, const jsi::Value &v);

static NSArray *getArray(jsi::Runtime &rt, const jsi::Value &v) {
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

static NSDictionary *getDict(jsi::Runtime &rt, const jsi::Value &v) {
  if (!v.isObject()) return @{};
  auto obj = v.asObject(rt);
  auto names = obj.getPropertyNames(rt);
  size_t len = names.size(rt);
  NSMutableDictionary *result = [NSMutableDictionary dictionaryWithCapacity:len];
  for (size_t i = 0; i < len; i++) {
    auto key = names.getValueAtIndex(rt, i).getString(rt).utf8(rt);
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
  if (v.isString()) return getStr(rt, v);
  if (v.isObject()) {
    auto obj = v.asObject(rt);
    if (obj.isArray(rt)) return getArray(rt, v);
    return getDict(rt, v);
  }
  return [NSNull null];
}

static id getObj(jsi::Runtime &rt, const jsi::Value &v) {
  return jsiToObjC(rt, v);
}

// --- Block wrapping: jsi::Function → ObjC RCTResponseSenderBlock ---

typedef void (^RCTResponseSenderBlock)(NSArray *);

// --- ObjC → JSI conversion (recursive) ---

static jsi::Value objcToJSI(jsi::Runtime &rt, id obj) {
  if (!obj) return jsi::Value::undefined();
  if ([obj isKindOfClass:[NSNull class]]) return jsi::Value::null();
  if ([obj isKindOfClass:[NSNumber class]]) {
    NSNumber *num = obj;
    if (strcmp([num objCType], @encode(BOOL)) == 0 ||
        strcmp([num objCType], @encode(char)) == 0) {
      return jsi::Value(static_cast<bool>([num boolValue]));
    }
    return jsi::Value(static_cast<double>([num doubleValue]));
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

static RCTResponseSenderBlock getBlock(jsi::Runtime &rt, const jsi::Value &v) {
  if (!v.isObject() || !v.asObject(rt).isFunction(rt)) {
    return ^(NSArray *r) {};
  }

  // Share the JS function via a shared_ptr so the block can own it
  auto fn = std::make_shared<jsi::Function>(v.asObject(rt).asFunction(rt));
  jsi::Runtime *rtPtr = &rt;

  return [^(NSArray *response) {
    if (!g_invoker || !*g_invoker) return;
    (*g_invoker)->invokeAsync([fn, rtPtr, response]() {
      auto &rt = *rtPtr;
      size_t argc = response.count;
      std::vector<jsi::Value> args;
      args.reserve(argc);
      for (size_t i = 0; i < argc; i++)
        args.push_back(objcToJSI(rt, response[i]));
      const jsi::Value *argsPtr = args.empty() ? nullptr : args.data();
      fn->call(rt, argsPtr, argc);
    });
  } copy];
}

// ---------------------------------------------------------------------------
// Registration: parse type encoding → store kinds
// ---------------------------------------------------------------------------

FerrumDispatchInfo *ferrum_dispatch_build(id instance, SEL selector, unsigned int expectedArgs) {
  Method m = class_getInstanceMethod([instance class], selector);

  if (m && expectedArgs > 0) {
    NSMethodSignature *sig = [instance methodSignatureForSelector:selector];
    if (sig && [sig numberOfArguments] - 2 != expectedArgs) {
      m = nullptr;
    }
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
        if ([name hasPrefix:prefix]) {
          m = methods[i];
          selector = method_getName(m);
          break;
        }
      }
      free(methods);
      cls = class_getSuperclass(cls);
    }
    if (!m) return nullptr;
  }

  NSMethodSignature *sig = [instance methodSignatureForSelector:selector];
  if (!sig) return nullptr;

  AKind retKind = kindFromEncoding([sig methodReturnType]);
  if (retKind == AKind::Unknown) return nullptr;

  NSUInteger nargs = [sig numberOfArguments] - 2;
  if (nargs > 4) return nullptr;

  AKind argKinds[4];
  for (NSUInteger i = 0; i < nargs; i++) {
    argKinds[i] = kindFromEncoding([sig getArgumentTypeAtIndex:i + 2]);
    if (argKinds[i] == AKind::Unknown) return nullptr;
  }

  auto *info = new FerrumDispatchInfo();
  info->instance = instance;
  info->selector = selector;
  info->retKind = (int)retKind;
  info->argCount = (unsigned int)nargs;
  for (unsigned int i = 0; i < nargs; i++)
    info->argKinds[i] = (int)argKinds[i];

  if ([instance respondsToSelector:@selector(methodQueue)])
    info->methodQueue = [(id<RCTBridgeModule>)instance methodQueue];
  else
    info->methodQueue = dispatch_get_main_queue();

  return info;
}

// ---------------------------------------------------------------------------
// Call: typed objc_msgSend from jsi::Value args
// ---------------------------------------------------------------------------

jsi::Value ferrum_dispatch_call_jsi(
    const FerrumDispatchInfo *info,
    jsi::Runtime &rt,
    const jsi::Value *args,
    size_t count) {

  id inst = info->instance;
  SEL sel = info->selector;
  AKind ret = (AKind)info->retKind;
  unsigned int nargs = info->argCount;

  // --- VOID RETURN (dispatch_async) ---
  if (ret == AKind::Void) {
    dispatch_queue_t q = info->methodQueue;
    AKind k0 = nargs > 0 ? (AKind)info->argKinds[0] : AKind::Void;
    AKind k1 = nargs > 1 ? (AKind)info->argKinds[1] : AKind::Void;
    AKind k2 = nargs > 2 ? (AKind)info->argKinds[2] : AKind::Void;

    if (nargs == 0) {
      dispatch_async(q, ^{ ((void(*)(id,SEL))objc_msgSend)(inst, sel); });
    } else if (nargs == 1 && k0 == AKind::Double) {
      double a0 = getNum(args[0]);
      dispatch_async(q, ^{ ((void(*)(id,SEL,double))objc_msgSend)(inst, sel, a0); });
    } else if (nargs == 1 && k0 == AKind::Bool) {
      BOOL a0 = getBool(args[0]);
      dispatch_async(q, ^{ ((void(*)(id,SEL,BOOL))objc_msgSend)(inst, sel, a0); });
    } else if (nargs == 1 && k0 == AKind::Object) {
      id a0 = getObj(rt, args[0]);
      dispatch_async(q, ^{ ((void(*)(id,SEL,id))objc_msgSend)(inst, sel, a0); });
    } else if (nargs == 1 && k0 == AKind::Int) {
      int a0 = (int)getNum(args[0]);
      dispatch_async(q, ^{ ((void(*)(id,SEL,int))objc_msgSend)(inst, sel, a0); });
    } else if (nargs == 1 && k0 == AKind::Block) {
      RCTResponseSenderBlock b0 = getBlock(rt, args[0]);
      dispatch_async(q, ^{ ((void(*)(id,SEL,id))objc_msgSend)(inst, sel, b0); });
    } else if (nargs == 2 && k0 == AKind::Double && k1 == AKind::Double) {
      double a0 = getNum(args[0]), a1 = getNum(args[1]);
      dispatch_async(q, ^{ ((void(*)(id,SEL,double,double))objc_msgSend)(inst, sel, a0, a1); });
    } else if (nargs == 2 && k0 == AKind::Object && k1 == AKind::Object) {
      id a0 = getObj(rt, args[0]), a1 = getObj(rt, args[1]);
      dispatch_async(q, ^{ ((void(*)(id,SEL,id,id))objc_msgSend)(inst, sel, a0, a1); });
    } else if (nargs == 2 && k0 == AKind::Object && k1 == AKind::Block) {
      id a0 = getObj(rt, args[0]);
      RCTResponseSenderBlock b1 = getBlock(rt, args[1]);
      dispatch_async(q, ^{ ((void(*)(id,SEL,id,id))objc_msgSend)(inst, sel, a0, b1); });
    } else if (nargs == 2 && k0 == AKind::Block && k1 == AKind::Block) {
      RCTResponseSenderBlock b0 = getBlock(rt, args[0]), b1 = getBlock(rt, args[1]);
      dispatch_async(q, ^{ ((void(*)(id,SEL,id,id))objc_msgSend)(inst, sel, b0, b1); });
    } else if (nargs == 2 && k0 == AKind::Object && k1 == AKind::Double) {
      id a0 = getObj(rt, args[0]); double a1 = getNum(args[1]);
      dispatch_async(q, ^{ ((void(*)(id,SEL,id,double))objc_msgSend)(inst, sel, a0, a1); });
    } else if (nargs == 3 && k0 == AKind::Object && k1 == AKind::Object && k2 == AKind::Object) {
      id a0 = getObj(rt, args[0]), a1 = getObj(rt, args[1]), a2 = getObj(rt, args[2]);
      dispatch_async(q, ^{ ((void(*)(id,SEL,id,id,id))objc_msgSend)(inst, sel, a0, a1, a2); });
    } else if (nargs == 3 && k0 == AKind::Object && k1 == AKind::Object && k2 == AKind::Block) {
      id a0 = getObj(rt, args[0]), a1 = getObj(rt, args[1]);
      RCTResponseSenderBlock b2 = getBlock(rt, args[2]);
      dispatch_async(q, ^{ ((void(*)(id,SEL,id,id,id))objc_msgSend)(inst, sel, a0, a1, b2); });
    } else {
      return jsi::Value::undefined();
    }
    return jsi::Value::undefined();
  }

  // --- DOUBLE RETURN ---
  if (ret == AKind::Double) {
    double r;
    if (nargs == 0) r = ((double(*)(id,SEL))objc_msgSend)(inst, sel);
    else if (nargs == 1 && (AKind)info->argKinds[0] == AKind::Double)
      r = ((double(*)(id,SEL,double))objc_msgSend)(inst, sel, getNum(args[0]));
    else if (nargs == 2 && (AKind)info->argKinds[0] == AKind::Double && (AKind)info->argKinds[1] == AKind::Double)
      r = ((double(*)(id,SEL,double,double))objc_msgSend)(inst, sel, getNum(args[0]), getNum(args[1]));
    else return jsi::Value::undefined();
    return jsi::Value(r);
  }

  // --- BOOL RETURN ---
  if (ret == AKind::Bool) {
    BOOL r;
    if (nargs == 0) r = ((BOOL(*)(id,SEL))objc_msgSend)(inst, sel);
    else if (nargs == 1 && (AKind)info->argKinds[0] == AKind::Bool)
      r = ((BOOL(*)(id,SEL,BOOL))objc_msgSend)(inst, sel, getBool(args[0]));
    else return jsi::Value::undefined();
    return jsi::Value(static_cast<bool>(r));
  }

  // --- OBJECT RETURN ---
  if (ret == AKind::Object) {
    id r;
    // Check if all args are primitives → NSNumber return, unwrap directly
    bool allPrimitive = true;
    for (unsigned int i = 0; i < nargs; i++) {
      AKind k = (AKind)info->argKinds[i];
      if (k != AKind::Double && k != AKind::Bool && k != AKind::Int) {
        allPrimitive = false; break;
      }
    }

    if (nargs == 0) r = ((id(*)(id,SEL))objc_msgSend)(inst, sel);
    else if (nargs == 1 && (AKind)info->argKinds[0] == AKind::Double)
      r = ((id(*)(id,SEL,double))objc_msgSend)(inst, sel, getNum(args[0]));
    else if (nargs == 1 && (AKind)info->argKinds[0] == AKind::Bool)
      r = ((id(*)(id,SEL,BOOL))objc_msgSend)(inst, sel, getBool(args[0]));
    else if (nargs == 1 && (AKind)info->argKinds[0] == AKind::Object)
      r = ((id(*)(id,SEL,id))objc_msgSend)(inst, sel, getObj(rt, args[0]));
    else if (nargs == 2 && (AKind)info->argKinds[0] == AKind::Double && (AKind)info->argKinds[1] == AKind::Double)
      r = ((id(*)(id,SEL,double,double))objc_msgSend)(inst, sel, getNum(args[0]), getNum(args[1]));
    else return jsi::Value::undefined();

    if (!r) return jsi::Value::null();
    if (allPrimitive && [r isKindOfClass:[NSNumber class]])
      return jsi::Value([r doubleValue]);
    if ([r isKindOfClass:[NSString class]])
      return jsi::String::createFromUtf8(rt, [(NSString *)r UTF8String]);
    return jsi::Value::null();
  }

  // --- INT RETURN ---
  if (ret == AKind::Int || ret == AKind::LongLong) {
    if (nargs == 0) {
      long long r = ((long long(*)(id,SEL))objc_msgSend)(inst, sel);
      return jsi::Value(static_cast<double>(r));
    }
  }

  return jsi::Value::undefined();
}

void ferrum_dispatch_free(FerrumDispatchInfo *info) {
  delete info;
}
