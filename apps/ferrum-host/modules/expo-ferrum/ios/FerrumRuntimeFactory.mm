/// FerrumRuntimeFactory — combines standard HermesRuntime with C ABI registration.
///
/// 1. Delegates to default factory for a fully-featured HermesRuntime
/// 2. Creates borrowed C ABI wrapper on the shared vm::Runtime (kept alive)
/// 3. Registers Rust function pointers via C ABI
/// 4. Installs __ferrumGetModule(name) — parallel to __turboModuleProxy —
///    that returns C ABI-backed module objects for benchmarking

#import <Foundation/Foundation.h>
#import <objc/runtime.h>
#include <react/runtime/JSRuntimeFactory.h>
#include <hermes/hermes.h>
#include <hermes_abi/hermes_abi.h>
#include <jsi/jsi.h>
#include <string>
#include <chrono>

#import "FerrumABIRegistry.h"
#import "FerrumFFIDispatch.h"

// For ObjCTurboModule::instance_ extraction
#include <ReactCommon/TurboModule.h>
#include <ReactCommon/RCTTurboModule.h>

// Vendored Hermes functions
extern "C" HermesABIRuntime *ferrum_wrap_vm_runtime(void *vmRuntime);

// Rust FFI
extern "C" void ferrum_register_globals(HermesABIRuntime *rt, const HermesABIRuntimeVTable *vt);

// Default Hermes factory (from RN)
extern "C" void *jsrt_create_hermes_factory(void);

// Forward declaration (defined below)
extern "C" void ferrum_install_abi_module_getter(void *rtPtr);


// ---------------------------------------------------------------------------
// Global state: borrowed C ABI wrapper (lives for entire app lifetime)
// ---------------------------------------------------------------------------

static HermesABIRuntime *g_abiRt = nullptr;
static const HermesABIRuntimeVTable *g_abiVt = nullptr;
static std::shared_ptr<facebook::react::CallInvoker> *g_jsInvoker = nullptr;

// ---------------------------------------------------------------------------
// C ABI HostFunction trampoline
// ---------------------------------------------------------------------------
// Wraps a codegen'd FerrumABIBridgeFn as a HermesABIHostFunction so it can
// be registered on the VM via create_function_from_host_function.

struct FerrumHostFunctionCtx : HermesABIHostFunction {
  FerrumABIBridgeFn bridgeFn;
  void *moduleInstance; // __bridge_retained void* to ObjC instance
  const HermesABIRuntimeVTable *vt;

  static HermesABIValueOrError call(
      HermesABIHostFunction *self,
      HermesABIRuntime *rt,
      const HermesABIValue *thisArg,
      const HermesABIValue *args,
      size_t count) {
    auto *ctx = static_cast<FerrumHostFunctionCtx *>(self);
    return ctx->bridgeFn(ctx->moduleInstance, rt, ctx->vt, thisArg, args, count);
  }

  static void release(HermesABIHostFunction *self) {
    auto *ctx = static_cast<FerrumHostFunctionCtx *>(self);
    if (ctx->moduleInstance) {
      CFRelease(ctx->moduleInstance);
    }
    delete ctx;
  }

  static constexpr HermesABIHostFunctionVTable kVTable = {release, call};
};

// ---------------------------------------------------------------------------
// V2: Generic passthrough trampoline
// ---------------------------------------------------------------------------
// Captures the EXISTING jsi::Function (which contains the hostFn with all
// type logic). Uses a HermesABIRuntimeWrapper (which IS a jsi::Runtime) to
// convert ABI↔JSI values using the same mechanism as the standard path.
//
// The VM dispatches to C ABI (bypassing HFContext/std::function/try-catch),
// the wrapper converts args, we call the original hostFn, wrapper converts
// result. Zero type reimplementation — all complexity stays in hostFn.

// The standard HermesRuntime — stored for the passthrough trampoline
static facebook::jsi::Runtime *g_jsiRuntime = nullptr;

// Forward declarations for helpers defined later in this file
static void releasePointer(HermesABIManagedPointer *ptr);
static HermesABIPropNameID makePropNameID(const char *name);

// Vendored: extract vm::HermesValue bits from ABI managed pointer
extern "C" uint64_t ferrum_abi_pointer_to_hv_bits(HermesABIManagedPointer *ptr);
// Vendored: create jsi::Value on standard runtime from vm::HermesValue bits
extern "C" void ferrum_hv_to_jsi(
    facebook::hermes::HermesRuntime *rt, uint64_t hvBits,
    facebook::jsi::Value *outVal);

/// Convert HermesABIValue → jsi::Value on the STANDARD runtime.
/// Primitives: direct construction (zero VM interaction).
/// Pointer types: extract vm::HermesValue from ABI pointer, create jsi::Value.
static facebook::jsi::Value abiToJSI(const HermesABIValue &v) {
  switch (v.kind) {
    case HermesABIValueKindUndefined: return facebook::jsi::Value::undefined();
    case HermesABIValueKindNull:      return facebook::jsi::Value(std::nullptr_t{});
    case HermesABIValueKindBoolean:   return facebook::jsi::Value(static_cast<bool>(v.data.boolean));
    case HermesABIValueKindNumber:    return facebook::jsi::Value(static_cast<double>(v.data.number));
    default: {
      // Pointer type — direct conversion via vendored functions
      uint64_t hvBits = ferrum_abi_pointer_to_hv_bits(v.data.pointer);
      facebook::jsi::Value result;
      ferrum_hv_to_jsi(
          static_cast<facebook::hermes::HermesRuntime *>(g_jsiRuntime),
          hvBits, &result);
      return result;
    }
  }
}

struct FerrumPassthroughCtx : HermesABIHostFunction {
  // The raw host function extracted from the jsi::Function.
  // This is the C++ function that does all the actual work.
  facebook::jsi::HostFunctionType hostFn;

  static HermesABIValueOrError call(
      HermesABIHostFunction *self,
      HermesABIRuntime *,
      const HermesABIValue *thisArg,
      const HermesABIValue *args,
      size_t count) {
    auto *ctx = static_cast<FerrumPassthroughCtx *>(self);
    auto &rt = *g_jsiRuntime;

    // Convert ABI args → JSI (primitives: zero-cost, pointers: vendored)
    std::vector<facebook::jsi::Value> jsiArgs;
    jsiArgs.reserve(count);
    for (size_t i = 0; i < count; i++)
      jsiArgs.push_back(abiToJSI(args[i]));

    auto jsiThis = abiToJSI(*thisArg);
    const facebook::jsi::Value *argsPtr = jsiArgs.empty() ? nullptr : jsiArgs.data();

    // Call the hostFn DIRECTLY
    auto result = ctx->hostFn(rt, jsiThis, argsPtr, count);

    // Convert result back (most methods return void/number/bool)
    HermesABIValueOrError r;
    if (result.isUndefined()) { r.value.kind = HermesABIValueKindUndefined; }
    else if (result.isNull()) { r.value.kind = HermesABIValueKindNull; }
    else if (result.isBool()) { r.value.kind = HermesABIValueKindBoolean; r.value.data.boolean = result.getBool(); }
    else if (result.isNumber()) { r.value.kind = HermesABIValueKindNumber; r.value.data.number = result.getNumber(); }
    else {
      // Pointer type result — rare for TurboModules, use temp global
      static const char *kTmp = "__frt";
      rt.global().setProperty(rt, kTmp, std::move(result));
      HermesABIPropNameID pn = makePropNameID(kTmp);
      HermesABIObject glob = g_abiVt->get_global_object(g_abiRt);
      r = g_abiVt->get_object_property_from_propnameid(g_abiRt, glob, pn);
      rt.global().setProperty(rt, kTmp, facebook::jsi::Value::undefined());
      releasePointer(glob.pointer);
      releasePointer(pn.pointer);
    }
    return r;
  }

  static void release(HermesABIHostFunction *self) {
    delete static_cast<FerrumPassthroughCtx *>(self);
  }

  static constexpr HermesABIHostFunctionVTable kVTable = {release, call};
};

// ---------------------------------------------------------------------------
// V2 FFI path: typed objc_msgSend via cached dispatch info
// ---------------------------------------------------------------------------

struct FerrumFFICtx : HermesABIHostFunction {
  FerrumDispatchInfo *dispatchInfo;

  static HermesABIValueOrError call(
      HermesABIHostFunction *self,
      HermesABIRuntime *abiRt,
      const HermesABIValue *thisArg,
      const HermesABIValue *args,
      size_t count) {
    auto *ctx = static_cast<FerrumFFICtx *>(self);
    return ferrum_dispatch_call(ctx->dispatchInfo, abiRt, g_abiVt, args, count);
  }

  static void release(HermesABIHostFunction *self) {
    auto *ctx = static_cast<FerrumFFICtx *>(self);
    ferrum_dispatch_free(ctx->dispatchInfo);
    delete ctx;
  }

  static constexpr HermesABIHostFunctionVTable kVTable = {release, call};
};

/// Register a FFI dispatch bridge — typed objc_msgSend, no NSInvocation.
/// Returns false if the method's type encoding is unsupported.
static bool registerFFIOnObject(
    HermesABIObject targetObj,
    const char *methodName,
    unsigned int argCount,
    id instance) {

  // Build selector from JS method name — ferrum_dispatch_build handles
  // scanning for the real ObjC selector (e.g., "add" → "add:b:")
  SEL sel = NSSelectorFromString(
      [NSString stringWithUTF8String:methodName]);

  FerrumDispatchInfo *info = ferrum_dispatch_build(instance, sel);
  if (!info) return false;

  auto *ctx = new FerrumFFICtx();
  ctx->vtable = &FerrumFFICtx::kVTable;
  ctx->dispatchInfo = info;

  HermesABIPropNameID propName = makePropNameID(methodName);
  if (!propName.pointer) {
    ferrum_dispatch_free(info);
    delete ctx;
    return false;
  }

  auto fnOrErr = g_abiVt->create_function_from_host_function(
      g_abiRt, propName, argCount, ctx);
  if (fnOrErr.ptr_or_error & 1) {
    releasePointer(propName.pointer);
    return false;
  }

  HermesABIValue fnVal;
  fnVal.kind = HermesABIValueKindObject;
  fnVal.data.pointer = reinterpret_cast<HermesABIManagedPointer *>(fnOrErr.ptr_or_error);
  g_abiVt->set_object_property_from_propnameid(g_abiRt, targetObj, propName, &fnVal);
  releasePointer(propName.pointer);
  return true;
}

/// Register a passthrough trampoline wrapping an existing JSI function.
/// Extracts the HostFunctionType and calls it directly — no VM dispatch.
static bool registerPassthroughOnObject(
    HermesABIObject targetObj,
    const char *methodName,
    unsigned int argCount,
    facebook::jsi::Function &&jsiFn) {

  // Extract the raw hostFn from the jsi::Function (protected, access via derived)
  struct RuntimeAccessor : facebook::jsi::Runtime {
    using Runtime::getHostFunction;
  };
  auto &hostFn = static_cast<RuntimeAccessor *>(g_jsiRuntime)->getHostFunction(jsiFn);

  auto *ctx = new FerrumPassthroughCtx();
  ctx->vtable = &FerrumPassthroughCtx::kVTable;
  ctx->hostFn = hostFn;  // copy the std::function

  HermesABIPropNameID propName = makePropNameID(methodName);
  if (!propName.pointer) return false;

  auto fnOrErr = g_abiVt->create_function_from_host_function(
      g_abiRt, propName, argCount, ctx);
  if (fnOrErr.ptr_or_error & 1) {
    releasePointer(propName.pointer);
    return false;
  }

  HermesABIValue fnVal;
  fnVal.kind = HermesABIValueKindObject;
  fnVal.data.pointer = reinterpret_cast<HermesABIManagedPointer *>(fnOrErr.ptr_or_error);
  g_abiVt->set_object_property_from_propnameid(g_abiRt, targetObj, propName, &fnVal);
  releasePointer(propName.pointer);
  return true;
}

// ---------------------------------------------------------------------------
// FerrumRuntimeFactory
// ---------------------------------------------------------------------------

namespace ferrum {

class FerrumRuntimeFactory : public facebook::react::JSRuntimeFactory {
public:
  std::unique_ptr<facebook::react::JSRuntime> createJSRuntime(
      std::shared_ptr<facebook::react::MessageQueueThread> msgQueueThread) noexcept override {

    NSLog(@"[Ferrum] FerrumRuntimeFactory: creating standard HermesRuntime");

    // 1. Create standard HermesRuntime via the default factory
    auto *defaultFactory = reinterpret_cast<facebook::react::JSRuntimeFactory *>(
        jsrt_create_hermes_factory());
    auto jsRuntime = defaultFactory->createJSRuntime(msgQueueThread);
    delete defaultFactory;

    // 2. Get vm::Runtime from HermesRuntime via vendored getter
    auto &jsiRuntime = jsRuntime->getRuntime();
    auto *hermesRuntime = static_cast<facebook::hermes::HermesRuntime *>(&jsiRuntime);
    void *vmRuntime = hermesRuntime->getVMRuntimeUnsafe();

    if (!vmRuntime) {
      NSLog(@"[Ferrum] WARNING: getVMRuntimeUnsafe returned null");
      return jsRuntime;
    }

    // 3. Create borrowed C ABI wrapper — kept alive for entire app lifetime
    //    Reset all globals in case of JS reload.
    if (g_jsInvoker) {
      delete g_jsInvoker;
      g_jsInvoker = nullptr;
    }
    g_abiRt = ferrum_wrap_vm_runtime(vmRuntime);
    g_abiVt = g_abiRt->vt;
    NSLog(@"[Ferrum] Borrowed C ABI wrapper created (permanent)");

    // 4. Register Rust function pointers
    ferrum_register_globals(g_abiRt, g_abiVt);
    NSLog(@"[Ferrum] Rust globals registered");

    // 5. C ABI bridges auto-register via __attribute__((constructor))
    //    in the generated files (requires -ObjC linker flag)

    // 5. Install __ferrumGetModule on the runtime
    //    __turboModuleProxy doesn't exist yet, but __ferrumGetModule
    //    grabs it lazily on first call from JS.
    // Store the standard JSI runtime for the passthrough trampoline
    g_jsiRuntime = &jsiRuntime;

    ferrum_install_abi_module_getter(&jsiRuntime);

    return jsRuntime;
  }
};

} // namespace ferrum

extern "C" void *ferrum_get_js_invoker(void) {
  return g_jsInvoker;
}

extern "C" void *jsrt_create_ferrum_factory(void) {
  NSLog(@"[Ferrum] jsrt_create_ferrum_factory");
  return reinterpret_cast<void *>(new ferrum::FerrumRuntimeFactory());
}

// ---------------------------------------------------------------------------
// __ferrumGetModule(moduleName) — parallel C ABI module getter
// ---------------------------------------------------------------------------
//
// Installed on the global alongside __turboModuleProxy. JS can call either:
//   const jsiModule = TurboModuleRegistry.get('Camera');  // standard JSI path
//   const abiModule = global.__ferrumGetModule('Camera');  // C ABI fast path
//
// This allows side-by-side benchmarking. The standard path is never touched.
//
// Implementation:
//   1. Calls __turboModuleProxy(name) to create the standard module + ObjC instance
//   2. Extracts ObjCTurboModule::instance_ from the HostObject prototype
//   3. Looks up codegen'd C ABI bridges in the registry
//   4. Creates a new JS object, registers C ABI bridge functions as properties
//   5. Returns the C ABI-backed object

/// Find the RCTTurboModuleManager via ObjC runtime and get a module instance by name.
static id ferrumGetModuleFromManager(const char *moduleName) {
  // RCTTurboModuleManager has moduleForName: — we just need to find the instance.
  // It's stored as _turboModuleManager ivar on RCTInstance.
  // Use ObjC runtime to find it.
  static id cachedManager = nil;
  if (!cachedManager) {
    Class rctInstanceClass = NSClassFromString(@"RCTInstance");
    if (!rctInstanceClass) {
      NSLog(@"[Ferrum] RCTInstance class not found");
      return nil;
    }
    // RCTTurboModuleManager conforms to RCTTurboModuleRegistry protocol
    // which has moduleForName:. Find any live instance.
    Class managerClass = NSClassFromString(@"RCTTurboModuleManager");
    if (!managerClass) {
      NSLog(@"[Ferrum] RCTTurboModuleManager class not found");
      return nil;
    }
    // The module registry is accessible via moduleForName: selector
    // We can find it through the RCTModuleRegistry which is set on bridge module decorators
    // Simplest: use the ivar on RCTInstance
    Ivar ivar = class_getInstanceVariable(rctInstanceClass, "_turboModuleManager");
    if (!ivar) {
      NSLog(@"[Ferrum] _turboModuleManager ivar not found on RCTInstance");
      return nil;
    }
    // We need an RCTInstance. It's not a singleton, but we can find it
    // through the notification center or by scanning live objects.
    // For now, log what we found and bail.
    NSLog(@"[Ferrum] Found _turboModuleManager ivar on RCTInstance, but need instance reference");
    // TODO: capture RCTInstance reference during factory creation
  }
  if (cachedManager && [cachedManager respondsToSelector:@selector(moduleForName:)]) {
    return [cachedManager performSelector:@selector(moduleForName:) withObject:@(moduleName)];
  }
  return nil;
}

/// Extract the ObjC module instance from a TurboModule's JS representation.
/// The proxy returns: jsRepresentation { __proto__: HostObject(TurboModule) }
/// ObjCTurboModule::instance_ is public.
static id<RCTBridgeModule> extractObjCInstance(
    facebook::jsi::Runtime &rt,
    const facebook::jsi::Object &moduleObj) {
  try {
    // Use Object.getPrototypeOf() — JSI's getProperty("__proto__") doesn't
    // trigger the ES2015 getter, so it returns undefined.
    auto Object = rt.global().getPropertyAsObject(rt, "Object");
    auto getPrototypeOf = Object.getPropertyAsFunction(rt, "getPrototypeOf");
    auto proto = getPrototypeOf.call(rt, moduleObj);

    if (!proto.isObject()) {
      NSLog(@"[Ferrum] extractObjCInstance: getPrototypeOf returned non-object");
      return nil;
    }

    auto protoObj = proto.asObject(rt);
    if (!protoObj.isHostObject(rt)) {
      NSLog(@"[Ferrum] extractObjCInstance: prototype is not a HostObject");
      return nil;
    }

    auto turboModule = protoObj.getHostObject<facebook::react::TurboModule>(rt);
    if (!turboModule) {
      NSLog(@"[Ferrum] extractObjCInstance: getHostObject<TurboModule> returned null");
      return nil;
    }

    auto *objcModule = dynamic_cast<facebook::react::ObjCTurboModule *>(turboModule.get());
    if (!objcModule) {
      NSLog(@"[Ferrum] extractObjCInstance: not an ObjCTurboModule (type: %s)",
            typeid(*turboModule.get()).name());
      return nil;
    }

    // Capture the CallInvoker for callback thread safety.
    // jsInvoker_ is protected, so we use a derived-class accessor trick.
    if (!g_jsInvoker) {
      struct Accessor : facebook::react::TurboModule {
        static std::shared_ptr<facebook::react::CallInvoker>
        getInvoker(facebook::react::TurboModule *t) {
          return static_cast<Accessor *>(t)->jsInvoker_;
        }
      };
      auto invoker = Accessor::getInvoker(turboModule.get());
      if (invoker) {
        g_jsInvoker = new std::shared_ptr<facebook::react::CallInvoker>(invoker);
        NSLog(@"[Ferrum] Captured CallInvoker from TurboModule");
      }
    }

    NSLog(@"[Ferrum] extractObjCInstance: got instance_ = %p",
          (__bridge void *)objcModule->instance_);
    return objcModule->instance_;
  } catch (const std::exception &e) {
    NSLog(@"[Ferrum] extractObjCInstance: exception: %s", e.what());
    return nil;
  } catch (...) {
    NSLog(@"[Ferrum] extractObjCInstance: unknown exception");
    return nil;
  }
}

/// Release a managed pointer via its vtable invalidate function.
static void releasePointer(HermesABIManagedPointer *ptr) {
  if (ptr && ptr->vtable) {
    ptr->vtable->invalidate(ptr);
  }
}

/// Create a PropNameID from a C string via the C ABI.
/// Returns {nullptr} on failure.
static HermesABIPropNameID makePropNameID(const char *name) {
  // First create a string
  auto strOrErr = g_abiVt->create_string_from_utf8(
      g_abiRt,
      reinterpret_cast<const uint8_t *>(name),
      strlen(name));
  if (strOrErr.ptr_or_error & 1) return {nullptr};

  HermesABIString str;
  str.pointer = reinterpret_cast<HermesABIManagedPointer *>(strOrErr.ptr_or_error);

  // Then create propnameid from string
  auto pnOrErr = g_abiVt->create_propnameid_from_string(g_abiRt, str);

  // Release the string
  releasePointer(str.pointer);

  if (pnOrErr.ptr_or_error & 1) return {nullptr};

  HermesABIPropNameID propName;
  propName.pointer = reinterpret_cast<HermesABIManagedPointer *>(pnOrErr.ptr_or_error);
  return propName;
}

/// Register a C ABI bridge function on a JS object via the borrowed wrapper.
/// The function is created on the vm::Runtime and set as a property.
/// Returns true if successful.
static bool registerABIBridgeOnObject(
    HermesABIObject targetObj,
    const char *methodName,
    unsigned int argCount,
    FerrumABIBridgeFn bridgeFn,
    id<RCTBridgeModule> instance) {

  // Create the trampoline
  auto *ctx = new FerrumHostFunctionCtx();
  ctx->vtable = &FerrumHostFunctionCtx::kVTable;
  ctx->bridgeFn = bridgeFn;
  ctx->moduleInstance = instance ? (__bridge_retained void *)instance : nullptr;
  ctx->vt = g_abiVt;

  // Create prop name
  HermesABIPropNameID propName = makePropNameID(methodName);
  if (!propName.pointer) return false;

  // Create the C ABI function
  auto fnOrErr = g_abiVt->create_function_from_host_function(
      g_abiRt, propName, argCount, ctx);
  if (fnOrErr.ptr_or_error & 1) {
    releasePointer(propName.pointer);
    return false;
  }

  // Convert function to a value (functions are objects)
  HermesABIValue fnVal;
  fnVal.kind = HermesABIValueKindObject;
  fnVal.data.pointer = reinterpret_cast<HermesABIManagedPointer *>(fnOrErr.ptr_or_error);

  // Set on target object
  g_abiVt->set_object_property_from_propnameid(g_abiRt, targetObj, propName, &fnVal);

  // Release our references (the object property now holds the function)
  releasePointer(propName.pointer);
  // Don't release fnVal — it's now owned by the object property

  return true;
}

extern "C" void ferrum_install_abi_module_getter(void *rtPtr) {
  if (!rtPtr || !g_abiRt) {
    NSLog(@"[Ferrum] Cannot install getter: rtPtr=%p, g_abiRt=%p", rtPtr, g_abiRt);
    return;
  }

  auto &rt = *reinterpret_cast<facebook::jsi::Runtime *>(rtPtr);

  try {
    auto global = rt.global();

    // Install __ferrumGetModule as a JSI host function.
    // __turboModuleProxy doesn't exist yet (factory runs before JS bindings),
    // so we look it up lazily on first call from JS.
    // JSI is used for: (a) calling the original proxy, (b) extracting HostObject.
    // The RETURNED object's methods are pure C ABI — zero JSI in the hot path.
    auto getter = facebook::jsi::Function::createFromHostFunction(
        rt,
        facebook::jsi::PropNameID::forAscii(rt, "__ferrumGetModule"),
        1,
        [](
            facebook::jsi::Runtime &runtime,
            const facebook::jsi::Value &thisVal,
            const facebook::jsi::Value *args,
            size_t count) -> facebook::jsi::Value {

          if (count < 1 || !args[0].isString()) {
            return facebook::jsi::Value::null();
          }

          std::string moduleName = args[0].getString(runtime).utf8(runtime);

          // Check if we have C ABI bridges for this module
          const FerrumABIBridgeEntry *entries =
              ferrum_abi_lookup_module(moduleName.c_str());
          if (!entries) {
            NSLog(@"[Ferrum] No C ABI bridges for '%s'", moduleName.c_str());
            return facebook::jsi::Value::null();
          }

          // Get the module instance from the TurboModule system via nativeModuleProxy.
          // This ensures we use the same singleton instance the JSI path uses.
          id instance = nil;

          // Try nativeModuleProxy (bridgeless) first
          auto nativeProxy = runtime.global().getProperty(runtime, "nativeModuleProxy");
          if (nativeProxy.isObject()) {
            // Try module name as-is, then without "Native" prefix
            auto moduleVal = nativeProxy.asObject(runtime).getProperty(
                runtime, moduleName.c_str());
            if (!moduleVal.isObject() && moduleName.substr(0, 6) == "Native") {
              moduleVal = nativeProxy.asObject(runtime).getProperty(
                  runtime, moduleName.substr(6).c_str());
            }
            if (moduleVal.isObject()) {
              instance = extractObjCInstance(runtime, moduleVal.asObject(runtime));
            }
          }

          // Fallback: try __turboModuleProxy
          if (!instance) {
            auto turboProxy = runtime.global().getProperty(runtime, "__turboModuleProxy");
            if (turboProxy.isObject() && turboProxy.asObject(runtime).isFunction(runtime)) {
              auto moduleVal = turboProxy.asObject(runtime).asFunction(runtime).call(
                  runtime, args, count);
              if (moduleVal.isObject()) {
                instance = extractObjCInstance(runtime, moduleVal.asObject(runtime));
              }
            }
          }

          // Last resort: direct instantiation
          if (!instance) {
            NSLog(@"[Ferrum] Could not get instance from TurboModule system, instantiating directly");
            Class moduleClass = NSClassFromString(
                [NSString stringWithUTF8String:moduleName.c_str()]);
            if (!moduleClass && moduleName.substr(0, 6) == "Native") {
              moduleClass = NSClassFromString(
                  [NSString stringWithUTF8String:moduleName.substr(6).c_str()]);
            }
            if (moduleClass) {
              instance = [[moduleClass alloc] init];
            }
          }

          if (!instance) {
            NSLog(@"[Ferrum] No instance for '%s'", moduleName.c_str());
            return facebook::jsi::Value::null();
          }

          NSLog(@"[Ferrum] Building C ABI module for '%s' (instance=%p)",
                moduleName.c_str(), (__bridge void *)instance);

          // Create a new JS object via C ABI
          auto objOrErr = g_abiVt->create_object(g_abiRt);
          if (objOrErr.ptr_or_error & 1) {
            NSLog(@"[Ferrum] Failed to create object for '%s'", moduleName.c_str());
            return facebook::jsi::Value::null();
          }

          HermesABIObject abiObj;
          abiObj.pointer = reinterpret_cast<HermesABIManagedPointer *>(objOrErr.ptr_or_error);

          // Register each bridge function as a property on the C ABI object
          int bridgeCount = 0;
          for (const FerrumABIBridgeEntry *e = entries; e->methodName; e++) {
            if (registerABIBridgeOnObject(abiObj, e->methodName, e->argCount,
                                          e->fn, instance)) {
              bridgeCount++;
            }
          }

          NSLog(@"[Ferrum] Registered %d C ABI bridges for '%s'",
                bridgeCount, moduleName.c_str());

          // Bridge the C ABI object back to JSI for return.
          // Set on a temp global property, read from JSI, then clean up.
          // Both share the same vm::Runtime so the object is the same.
          std::string tempKey = "__ferrum_tmp_" + moduleName;
          HermesABIPropNameID tempPropName = makePropNameID(tempKey.c_str());

          HermesABIObject globalObj = g_abiVt->get_global_object(g_abiRt);
          HermesABIValue objVal;
          objVal.kind = HermesABIValueKindObject;
          objVal.data.pointer = abiObj.pointer;

          g_abiVt->set_object_property_from_propnameid(
              g_abiRt, globalObj, tempPropName, &objVal);

          // Read from JSI
          auto result = runtime.global().getProperty(runtime, tempKey.c_str());

          // Clean up temp property
          runtime.global().setProperty(runtime, tempKey.c_str(),
                                       facebook::jsi::Value::undefined());

          // Release C ABI references
          releasePointer(abiObj.pointer);
          releasePointer(globalObj.pointer);
          releasePointer(tempPropName.pointer);

          return result;
        });

    global.setProperty(rt, "__ferrumGetModule", getter);
    NSLog(@"[Ferrum] __ferrumGetModule installed on global");

    // --- V2: Passthrough approach ---
    // Instead of codegen'd type handling, captures existing JSI functions
    // and re-registers them as C ABI trampolines. Zero type reimplementation.
    auto getterV2 = facebook::jsi::Function::createFromHostFunction(
        rt,
        facebook::jsi::PropNameID::forAscii(rt, "__ferrumGetModuleV2"),
        1,
        [](
            facebook::jsi::Runtime &runtime,
            const facebook::jsi::Value &thisVal,
            const facebook::jsi::Value *args,
            size_t count) -> facebook::jsi::Value {

          if (count < 1 || !args[0].isString())
            return facebook::jsi::Value::null();

          std::string moduleName = args[0].getString(runtime).utf8(runtime);

          // Get module from nativeModuleProxy
          auto nativeProxy = runtime.global().getProperty(runtime, "nativeModuleProxy");
          if (!nativeProxy.isObject())
            return facebook::jsi::Value::null();

          auto moduleVal = nativeProxy.asObject(runtime).getProperty(
              runtime, moduleName.c_str());
          if (!moduleVal.isObject())
            return facebook::jsi::Value::null();

          auto moduleObj = moduleVal.asObject(runtime);

          // Get method names from our registry (just names, no type info needed)
          const FerrumABIBridgeEntry *entries =
              ferrum_abi_lookup_module(moduleName.c_str());
          if (!entries) {
            NSLog(@"[Ferrum V2] No registry for '%s'", moduleName.c_str());
            return facebook::jsi::Value::null();
          }

          NSLog(@"[Ferrum V2] Building module for '%s'", moduleName.c_str());

          // Extract ObjC instance for FFI dispatch
          id objcInstance = extractObjCInstance(runtime, moduleObj);

          // Create new JS object via C ABI
          auto objOrErr = g_abiVt->create_object(g_abiRt);
          if (objOrErr.ptr_or_error & 1)
            return facebook::jsi::Value::null();

          HermesABIObject abiObj;
          abiObj.pointer = reinterpret_cast<HermesABIManagedPointer *>(objOrErr.ptr_or_error);

          int ffiCount = 0, passthroughCount = 0;
          for (const FerrumABIBridgeEntry *e = entries; e->methodName; e++) {
            // Try FFI dispatch first (typed objc_msgSend, no NSInvocation)
            if (objcInstance && registerFFIOnObject(
                    abiObj, e->methodName, e->argCount, objcInstance)) {
              NSLog(@"[Ferrum V2]   %s → FFI", e->methodName);
              ffiCount++;
              continue;
            }

            // Fallback: passthrough via hostFn
            auto propVal = moduleObj.getProperty(runtime, e->methodName);
            if (!propVal.isObject()) continue;
            auto propObj = propVal.asObject(runtime);
            if (!propObj.isFunction(runtime)) continue;

            if (registerPassthroughOnObject(
                    abiObj, e->methodName, e->argCount,
                    propObj.asFunction(runtime))) {
              NSLog(@"[Ferrum V2]   %s → passthrough", e->methodName);
              passthroughCount++;
            }
          }

          NSLog(@"[Ferrum V2] '%s': %d FFI + %d passthrough bridges",
                moduleName.c_str(), ffiCount, passthroughCount);

          // Bridge C ABI object to JSI via temp global
          std::string tempKey = "__ferrum_tmp2_" + moduleName;
          HermesABIPropNameID tempPN = makePropNameID(tempKey.c_str());
          HermesABIObject glob = g_abiVt->get_global_object(g_abiRt);
          HermesABIValue objVal;
          objVal.kind = HermesABIValueKindObject;
          objVal.data.pointer = abiObj.pointer;
          g_abiVt->set_object_property_from_propnameid(g_abiRt, glob, tempPN, &objVal);

          auto result = runtime.global().getProperty(runtime, tempKey.c_str());
          runtime.global().setProperty(runtime, tempKey.c_str(),
                                       facebook::jsi::Value::undefined());
          releasePointer(abiObj.pointer);
          releasePointer(glob.pointer);
          releasePointer(tempPN.pointer);
          return result;
        });

    global.setProperty(rt, "__ferrumGetModuleV2", getterV2);
    NSLog(@"[Ferrum] __ferrumGetModuleV2 installed on global");

  } catch (const std::exception &e) {
    NSLog(@"[Ferrum] Exception installing getter: %s", e.what());
  }
}
