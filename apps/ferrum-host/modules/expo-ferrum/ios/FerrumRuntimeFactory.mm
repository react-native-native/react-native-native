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

#import "FerrumFFIDispatch.h"

// For ObjCTurboModule::instance_ extraction
#include <ReactCommon/TurboModule.h>
#include <ReactCommon/RCTTurboModule.h>


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
// V2 FFI: typed objc_msgSend dispatch
// ---------------------------------------------------------------------------
//
// the wrapper converts args, we call the original hostFn, wrapper converts
// result. Zero type reimplementation — all complexity stays in hostFn.

// The standard HermesRuntime — stored for the passthrough trampoline

// Forward declarations for helpers defined later in this file
static void releasePointer(HermesABIManagedPointer *ptr);
static HermesABIPropNameID makePropNameID(const char *name);

// ---------------------------------------------------------------------------
// V2 FFI path: typed objc_msgSend via cached dispatch info
// ---------------------------------------------------------------------------

struct FerrumFFICtx : HermesABIHostFunction {
  // Inline the dispatch info — single allocation, no pointer chasing
  FerrumDispatchInfo info;

  static HermesABIValueOrError call(
      HermesABIHostFunction *self,
      HermesABIRuntime *abiRt,
      const HermesABIValue *thisArg,
      const HermesABIValue *args,
      size_t count) {
    auto *ctx = static_cast<FerrumFFICtx *>(self);
    return ctx->info.callFn(&ctx->info, abiRt, g_abiVt, args, count);
  }

  static void release(HermesABIHostFunction *self) {
    delete static_cast<FerrumFFICtx *>(self);
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

  FerrumDispatchInfo *info = ferrum_dispatch_build(instance, sel, argCount);
  if (!info) return false;

  auto *ctx = new FerrumFFICtx();
  ctx->vtable = &FerrumFFICtx::kVTable;
  ctx->info = *info; // copy inline — no pointer chasing at call time
  ferrum_dispatch_free(info);

  HermesABIPropNameID propName = makePropNameID(methodName);
  if (!propName.pointer) {
    delete ctx;
    return false;
  }

  auto fnOrErr = g_abiVt->create_function_from_host_function(
      g_abiRt, propName, argCount,
      static_cast<HermesABIHostFunction *>(ctx));
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

    // 2. Create shared C ABI runtime on the same VM
    auto &jsiRuntime = jsRuntime->getRuntime();
    auto *hermesRuntime = static_cast<facebook::hermes::HermesRuntime *>(&jsiRuntime);
    g_abiRt = facebook::hermes::hermesCreateSharedABIRuntime(hermesRuntime);

    if (!g_abiRt) {
      NSLog(@"[Ferrum] WARNING: createSharedABIRuntime returned null");
      return jsRuntime;
    }

    g_abiVt = g_abiRt->vt;
    if (g_jsInvoker) {
      delete g_jsInvoker;
      g_jsInvoker = nullptr;
    }
    NSLog(@"[Ferrum] Shared C ABI runtime created");

    // 4. Register Rust function pointers

    // 5. C ABI bridges auto-register via __attribute__((constructor))
    //    in the generated files (requires -ObjC linker flag)

    // 5. Install __ferrumGetModule on the runtime
    //    __turboModuleProxy doesn't exist yet, but __ferrumGetModule
    //    grabs it lazily on first call from JS.
    // Store the standard JSI runtime for the passthrough trampoline
    ferrum_install_abi_module_getter(&jsiRuntime);

    return jsRuntime;
  }
};

} // namespace ferrum

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
        // Pass to FFI dispatcher for block/callback wrapping
        ferrum_dispatch_set_globals(g_abiRt, g_abiVt, g_jsInvoker);
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

extern "C" void ferrum_install_abi_module_getter(void *rtPtr) {
  if (!rtPtr || !g_abiRt) {
    NSLog(@"[Ferrum] Cannot install getter: rtPtr=%p, g_abiRt=%p", rtPtr, g_abiRt);
    return;
  }

  auto &rt = *reinterpret_cast<facebook::jsi::Runtime *>(rtPtr);

  try {
    auto global = rt.global();

    // Install __ferrumGetModule — discovers methods from ObjC runtime,
    // builds FFI dispatch for each. No codegen, no registry.
    auto getterV2 = facebook::jsi::Function::createFromHostFunction(
        rt,
        facebook::jsi::PropNameID::forAscii(rt, "__ferrumGetModule"),
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

          // Extract ObjC instance for FFI dispatch
          id objcInstance = extractObjCInstance(runtime, moduleObj);
          if (!objcInstance) {
            NSLog(@"[Ferrum V2] No ObjC instance for '%s'", moduleName.c_str());
            return facebook::jsi::Value::null();
          }

          NSLog(@"[Ferrum V2] Building module for '%s'", moduleName.c_str());

          // Create new JS object via C ABI
          auto objOrErr = g_abiVt->create_object(g_abiRt);
          if (objOrErr.ptr_or_error & 1)
            return facebook::jsi::Value::null();

          HermesABIObject abiObj;
          abiObj.pointer = reinterpret_cast<HermesABIManagedPointer *>(objOrErr.ptr_or_error);

          // Discover methods from ObjC runtime — no codegen, no registry
          int ffiCount = 0, skipped = 0;
          unsigned int methodCount = 0;
          Class cls = [objcInstance class];
          // Scan class hierarchy for methods
          while (cls) {
            Method *methods = class_copyMethodList(cls, &methodCount);
            for (unsigned int i = 0; i < methodCount; i++) {
              SEL sel = method_getName(methods[i]);
              NSString *selName = NSStringFromSelector(sel);

              // Skip private/internal methods (underscore prefix, init, dealloc, etc.)
              if ([selName hasPrefix:@"_"] || [selName hasPrefix:@"."] ||
                  [selName isEqualToString:@"init"] ||
                  [selName isEqualToString:@"dealloc"] ||
                  [selName isEqualToString:@"methodQueue"] ||
                  [selName isEqualToString:@"moduleName"] ||
                  [selName hasPrefix:@"constantsToExport"] ||
                  [selName hasPrefix:@"getConstants"]) {
                continue;
              }

              // Get arg count from selector (number of colons)
              NSUInteger argCount = [[selName componentsSeparatedByString:@":"] count] - 1;

              // Try to build FFI dispatch
              FerrumDispatchInfo *info = ferrum_dispatch_build(objcInstance, sel, (unsigned int)argCount);
              if (!info) continue;

              // JS method name = first part of selector (before first colon)
              NSString *jsName = [selName componentsSeparatedByString:@":"][0];
              const char *jsNameC = [jsName UTF8String];

              // Register on the V2 object
              auto *ctx = new FerrumFFICtx();
              ctx->vtable = &FerrumFFICtx::kVTable;
              ctx->info = *info;
              ferrum_dispatch_free(info);

              HermesABIPropNameID propName = makePropNameID(jsNameC);
              if (!propName.pointer) { delete ctx; continue; }

              auto fnOrErr = g_abiVt->create_function_from_host_function(
                  g_abiRt, propName, (unsigned int)argCount,
                  static_cast<HermesABIHostFunction *>(ctx));
              if (fnOrErr.ptr_or_error & 1) {
                releasePointer(propName.pointer);
                continue;
              }

              HermesABIValue fnVal;
              fnVal.kind = HermesABIValueKindObject;
              fnVal.data.pointer = reinterpret_cast<HermesABIManagedPointer *>(fnOrErr.ptr_or_error);
              g_abiVt->set_object_property_from_propnameid(g_abiRt, abiObj, propName, &fnVal);
              releasePointer(propName.pointer);

              NSLog(@"[Ferrum V2]   %s → FFI", jsNameC);
              ffiCount++;
            }
            free(methods);
            cls = class_getSuperclass(cls);
            // Stop at NSObject — don't scan base class methods
            if (cls == [NSObject class]) break;
          }

          NSLog(@"[Ferrum V2] '%s': %d FFI methods",
                moduleName.c_str(), ffiCount);

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

    global.setProperty(rt, "__ferrumGetModule", getterV2);
    NSLog(@"[Ferrum] __ferrumGetModule installed on global");

  } catch (const std::exception &e) {
    NSLog(@"[Ferrum] Exception installing getter: %s", e.what());
  }
}
