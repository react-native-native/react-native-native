/// Ferrum — TurboModule acceleration for React Native.
///
/// Bypasses NSInvocation with typed objc_msgSend, registered as JSI host
/// functions. Zero vendored Hermes changes. Pure JSI + ObjC runtime.
///
/// Boot sequence:
/// 1. +load swizzles createJSRuntimeFactory to inject FerrumRuntimeFactory
/// 2. Factory creates standard HermesRuntime, traps Object.defineProperty
/// 3. RN's installJSBindings → defineReadOnlyGlobal("nativeModuleProxy", ...)
/// 4. Our trap fires, wraps value with FerrumModuleProxy before it's frozen
/// 5. NativeModules.js captures the WRAPPED proxy — all lookups go through Ferrum
/// 6. On first access, FerrumModuleProxy overlays typed objc_msgSend on each method

#import <Foundation/Foundation.h>
#import <objc/runtime.h>
#import <objc/message.h>
#include <react/runtime/JSRuntimeFactory.h>
#include <hermes/hermes.h>
#include <jsi/jsi.h>
#include <string>

#include <ReactCommon/TurboModule.h>
#include <ReactCommon/RCTTurboModule.h>
#include <ReactCommon/CallInvoker.h>

#import "FerrumFFIDispatch.h"

extern "C" void *jsrt_create_hermes_factory(void);

#ifndef FERRUM_VERBOSE
#define FERRUM_VERBOSE 0
#endif
#define FERRUM_LOG(...) NSLog(@"[Ferrum] " __VA_ARGS__)
#define FERRUM_VLOG(...) do { if (FERRUM_VERBOSE) NSLog(@"[Ferrum] " __VA_ARGS__); } while(0)

// Original nativeModuleProxy HostObject (before wrapping)
static std::shared_ptr<facebook::jsi::HostObject> g_originalProxy = nullptr;

// Saved original Object.defineProperty
static std::shared_ptr<facebook::jsi::Function> g_realDefineProperty = nullptr;

// ---------------------------------------------------------------------------
// Instance extraction from TurboModule HostObject
// ---------------------------------------------------------------------------

static id<RCTBridgeModule> extractObjCInstance(
    facebook::jsi::Runtime &rt,
    const facebook::jsi::Object &moduleObj) {
  try {
    auto Object = rt.global().getPropertyAsObject(rt, "Object");
    auto getPrototypeOf = Object.getPropertyAsFunction(rt, "getPrototypeOf");
    auto proto = getPrototypeOf.call(rt, moduleObj);
    if (!proto.isObject()) return nil;

    auto protoObj = proto.asObject(rt);
    if (!protoObj.isHostObject(rt)) return nil;

    auto turboModule = protoObj.getHostObject<facebook::react::TurboModule>(rt);
    if (!turboModule) return nil;

    auto *objcModule = dynamic_cast<facebook::react::ObjCTurboModule *>(turboModule.get());
    if (!objcModule) return nil;

    // Re-capture CallInvoker on every extraction — handles JS reload
    {
      struct Accessor : facebook::react::TurboModule {
        static std::shared_ptr<facebook::react::CallInvoker>
        getInvoker(facebook::react::TurboModule *t) {
          return static_cast<Accessor *>(t)->jsInvoker_;
        }
      };
      auto invoker = Accessor::getInvoker(turboModule.get());
      if (invoker) {
        auto *stored = new std::shared_ptr<facebook::react::CallInvoker>(invoker);
        ferrum_dispatch_set_globals(stored);
      }
    }

    return objcModule->instance_;
  } catch (...) {
    return nil;
  }
}

// ---------------------------------------------------------------------------
// Shared: overlay FFI methods on a module object
// ---------------------------------------------------------------------------

static int ferrumOverlayFFI(
    facebook::jsi::Runtime &rt,
    facebook::jsi::Object &moduleObj,
    id objcInstance) {
  int accelerated = 0;
  Class cls = [objcInstance class];
  while (cls && cls != [NSObject class]) {
    unsigned int methodCount = 0;
    Method *methods = class_copyMethodList(cls, &methodCount);
    for (unsigned int i = 0; i < methodCount; i++) {
      SEL sel = method_getName(methods[i]);
      NSString *selName = NSStringFromSelector(sel);

      if ([selName hasPrefix:@"_"] || [selName hasPrefix:@"."] ||
          [selName isEqualToString:@"init"] ||
          [selName isEqualToString:@"dealloc"] ||
          [selName isEqualToString:@"methodQueue"] ||
          [selName isEqualToString:@"moduleName"] ||
          [selName hasPrefix:@"constantsToExport"] ||
          [selName hasPrefix:@"getConstants"]) {
        continue;
      }

      NSUInteger argCount = [[selName componentsSeparatedByString:@":"] count] - 1;
      FerrumDispatchInfo *info = ferrum_dispatch_build(objcInstance, sel, (unsigned int)argCount);
      if (!info) continue;

      NSString *jsName = [selName componentsSeparatedByString:@":"][0];
      auto sharedInfo = std::make_shared<FerrumDispatchInfo>(*info);
      ferrum_dispatch_free(info);

      auto fn = facebook::jsi::Function::createFromHostFunction(
          rt,
          facebook::jsi::PropNameID::forAscii(rt, [jsName UTF8String]),
          (unsigned int)argCount,
          [sharedInfo](
              facebook::jsi::Runtime &rt2,
              const facebook::jsi::Value &,
              const facebook::jsi::Value *jsiArgs,
              size_t cnt) -> facebook::jsi::Value {
            return ferrum_dispatch_call_jsi(sharedInfo.get(), rt2, jsiArgs, cnt);
          });

      moduleObj.setProperty(rt, [jsName UTF8String], std::move(fn));
      accelerated++;
    }
    free(methods);
    cls = class_getSuperclass(cls);
  }
  return accelerated;
}

// ---------------------------------------------------------------------------
// __ferrumGetModule — explicit module access for benchmarking / hot paths
// ---------------------------------------------------------------------------

static facebook::jsi::Value ferrumGetModule(
    facebook::jsi::Runtime &runtime,
    const facebook::jsi::Value &thisVal,
    const facebook::jsi::Value *args,
    size_t count) {

  if (count < 1 || !args[0].isString())
    return facebook::jsi::Value::null();

  std::string moduleName = args[0].getString(runtime).utf8(runtime);

  if (!g_originalProxy) {
    auto nativeProxy = runtime.global().getProperty(runtime, "nativeModuleProxy");
    if (!nativeProxy.isObject()) return facebook::jsi::Value::null();
    auto obj = nativeProxy.asObject(runtime);
    if (obj.isHostObject(runtime)) {
      g_originalProxy = obj.getHostObject(runtime);
    }
  }
  if (!g_originalProxy) return facebook::jsi::Value::null();

  auto moduleVal = g_originalProxy->get(runtime,
      facebook::jsi::PropNameID::forUtf8(runtime, moduleName));
  if (!moduleVal.isObject()) return facebook::jsi::Value::null();

  auto moduleObj = moduleVal.asObject(runtime);
  id objcInstance = extractObjCInstance(runtime, moduleObj);
  if (!objcInstance) return facebook::jsi::Value::null();

  // Build a standalone object with only FFI methods (no JSI fallbacks)
  auto ferrumObj = facebook::jsi::Object(runtime);
  int n = ferrumOverlayFFI(runtime, ferrumObj, objcInstance);

  FERRUM_VLOG(@"'%s': %d methods (direct)", moduleName.c_str(), n);
  return facebook::jsi::Value(runtime, ferrumObj);
}

// ---------------------------------------------------------------------------
// __ferrumGetJSIModule — original JSI module without FFI overlay (benchmarking)
// ---------------------------------------------------------------------------

static facebook::jsi::Value ferrumGetJSIModule(
    facebook::jsi::Runtime &runtime,
    const facebook::jsi::Value &thisVal,
    const facebook::jsi::Value *args,
    size_t count) {

  if (count < 1 || !args[0].isString())
    return facebook::jsi::Value::null();

  if (!g_originalProxy) return facebook::jsi::Value::null();

  // Fresh plain object with invokeObjCMethod functions from the prototype.
  // Simulates the upstream eager-population fix: NSInvocation on an optimized
  // hidden class. This is the fairest baseline — same object shape as Proxy/FFI,
  // only the dispatch mechanism differs.
  std::string moduleName = args[0].getString(runtime).utf8(runtime);
  auto moduleVal = g_originalProxy->get(runtime,
      facebook::jsi::PropNameID::forUtf8(runtime, moduleName));
  if (!moduleVal.isObject()) return facebook::jsi::Value::null();

  auto moduleObj = moduleVal.asObject(runtime);
  auto freshObj = facebook::jsi::Object(runtime);

  auto Object = runtime.global().getPropertyAsObject(runtime, "Object");
  auto getProto = Object.getPropertyAsFunction(runtime, "getPrototypeOf");
  auto protoVal = getProto.call(runtime, moduleObj);
  if (protoVal.isObject()) {
    auto proto = protoVal.asObject(runtime);
    auto names = proto.getPropertyNames(runtime);
    for (size_t i = 0; i < names.size(runtime); i++) {
      auto name = names.getValueAtIndex(runtime, i).getString(runtime);
      auto propId = facebook::jsi::PropNameID::forString(runtime, name);
      freshObj.setProperty(runtime, propId, proto.getProperty(runtime, propId));
    }
  }
  auto ownNames = moduleObj.getPropertyNames(runtime);
  for (size_t i = 0; i < ownNames.size(runtime); i++) {
    auto name = ownNames.getValueAtIndex(runtime, i).getString(runtime);
    auto propId = facebook::jsi::PropNameID::forString(runtime, name);
    freshObj.setProperty(runtime, propId, moduleObj.getProperty(runtime, propId));
  }
  return facebook::jsi::Value(runtime, freshObj);
}

// ---------------------------------------------------------------------------
// FerrumModuleProxy — HostObject wrapping nativeModuleProxy
// ---------------------------------------------------------------------------
// Intercepts property access: overlays FFI on first access, caches result,
// falls back to original JSI for modules it can't handle.

class FerrumModuleProxy : public facebook::jsi::HostObject {
  std::shared_ptr<facebook::jsi::HostObject> original_;
  std::unordered_map<std::string, std::shared_ptr<facebook::jsi::Object>> cache_;

public:
  FerrumModuleProxy(std::shared_ptr<facebook::jsi::HostObject> original)
      : original_(std::move(original)) {}

  facebook::jsi::Value get(facebook::jsi::Runtime &rt,
                           const facebook::jsi::PropNameID &name) override {
    std::string propName = name.utf8(rt);

    auto it = cache_.find(propName);
    if (it != cache_.end()) {
      return facebook::jsi::Value(rt, *it->second);
    }

    auto moduleVal = original_->get(rt, name);
    if (!moduleVal.isObject()) return moduleVal;

    auto moduleObj = moduleVal.asObject(rt);
    id objcInstance = extractObjCInstance(rt, moduleObj);
    if (!objcInstance) return moduleVal;

    // Build a FRESH plain object — avoids the deoptimized hidden class of
    // jsRepresentation (whose __proto__ was mutated by TurboModuleBinding).
    // 1. Copy prototype methods (getConstants, addListener, etc.) as baseline
    // 2. Overlay FFI methods on top — FFI wins for supported signatures,
    //    prototype methods remain for everything else.
    auto freshObj = facebook::jsi::Object(rt);

    // Copy all accessible properties from the original module (prototype + own)
    auto Object = rt.global().getPropertyAsObject(rt, "Object");
    auto getProto = Object.getPropertyAsFunction(rt, "getPrototypeOf");
    auto protoVal = getProto.call(rt, moduleObj);
    if (protoVal.isObject()) {
      auto proto = protoVal.asObject(rt);
      auto protoNames = proto.getPropertyNames(rt);
      for (size_t i = 0; i < protoNames.size(rt); i++) {
        auto pname = protoNames.getValueAtIndex(rt, i).getString(rt);
        auto pid = facebook::jsi::PropNameID::forString(rt, pname);
        freshObj.setProperty(rt, pid, proto.getProperty(rt, pid));
      }
    }
    // Copy own properties from jsRepresentation (if any were lazily cached)
    auto ownNames = moduleObj.getPropertyNames(rt);
    for (size_t i = 0; i < ownNames.size(rt); i++) {
      auto oname = ownNames.getValueAtIndex(rt, i).getString(rt);
      auto oid = facebook::jsi::PropNameID::forString(rt, oname);
      freshObj.setProperty(rt, oid, moduleObj.getProperty(rt, oid));
    }

    // Overlay FFI — overwrites prototype methods with typed objc_msgSend
    int n = ferrumOverlayFFI(rt, freshObj, objcInstance);
    FERRUM_VLOG(@"'%s': %d methods accelerated", propName.c_str(), n);

    auto cached = std::make_shared<facebook::jsi::Object>(std::move(freshObj));
    cache_.emplace(propName, cached);
    return facebook::jsi::Value(rt, *cached);
  }

  void set(facebook::jsi::Runtime &rt,
           const facebook::jsi::PropNameID &name,
           const facebook::jsi::Value &value) override {
    original_->set(rt, name, value);
  }

  std::vector<facebook::jsi::PropNameID> getPropertyNames(
      facebook::jsi::Runtime &rt) override {
    return original_->getPropertyNames(rt);
  }
};

// ---------------------------------------------------------------------------
// FerrumRuntimeFactory
// ---------------------------------------------------------------------------

namespace {

class FerrumRuntimeFactory : public facebook::react::JSRuntimeFactory {
public:
  std::unique_ptr<facebook::react::JSRuntime> createJSRuntime(
      std::shared_ptr<facebook::react::MessageQueueThread> msgQueueThread) noexcept override {

    auto *defaultFactory = reinterpret_cast<facebook::react::JSRuntimeFactory *>(
        jsrt_create_hermes_factory());
    auto jsRuntime = defaultFactory->createJSRuntime(msgQueueThread);
    delete defaultFactory;

    auto &rt = jsRuntime->getRuntime();

    // Clear stale references from previous runtime (JS reload)
    g_originalProxy = nullptr;
    g_realDefineProperty = nullptr;
    ferrum_dispatch_set_runtime(&rt);

    // Install __ferrumGetModule for explicit use / benchmarking
    auto getter = facebook::jsi::Function::createFromHostFunction(
        rt,
        facebook::jsi::PropNameID::forAscii(rt, "__ferrumGetModule"),
        1,
        ferrumGetModule);
    rt.global().setProperty(rt, "__ferrumGetModule", getter);

    // Install __ferrumGetJSIModule for benchmarking the original NSInvocation path
    auto jsiGetter = facebook::jsi::Function::createFromHostFunction(
        rt,
        facebook::jsi::PropNameID::forAscii(rt, "__ferrumGetJSIModule"),
        1,
        ferrumGetJSIModule);
    rt.global().setProperty(rt, "__ferrumGetJSIModule", jsiGetter);

    // ---------------------------------------------------------------
    // Object.defineProperty trap
    // ---------------------------------------------------------------
    // RN's defineReadOnlyGlobal() fetches Object.defineProperty via JSI
    // and calls it to install nativeModuleProxy. We replace it BEFORE
    // installJSBindings runs. When nativeModuleProxy is defined, our
    // trap wraps the value with FerrumModuleProxy, then forwards to the
    // real defineProperty. The read-only global is locked with our proxy
    // inside — NativeModules.js captures it, all lookups go through Ferrum.
    {
      auto Object = rt.global().getPropertyAsObject(rt, "Object");
      auto realDP = Object.getPropertyAsFunction(rt, "defineProperty");
      g_realDefineProperty = std::make_shared<facebook::jsi::Function>(std::move(realDP));

      auto trap = facebook::jsi::Function::createFromHostFunction(
          rt,
          facebook::jsi::PropNameID::forAscii(rt, "defineProperty"),
          3,
          [](facebook::jsi::Runtime &rt,
             const facebook::jsi::Value &thisVal,
             const facebook::jsi::Value *args,
             size_t count) -> facebook::jsi::Value {

            if (count >= 3 && args[1].isString()) {
              auto propName = args[1].getString(rt).utf8(rt);

              if (propName == "nativeModuleProxy" && args[2].isObject()) {
                auto descriptor = args[2].asObject(rt);
                auto value = descriptor.getProperty(rt, "value");
                if (value.isObject()) {
                  auto obj = value.asObject(rt);
                  if (obj.isHostObject(rt)) {
                    auto original = obj.getHostObject(rt);
                    g_originalProxy = original;
                    auto wrapped = std::make_shared<FerrumModuleProxy>(original);
                    auto wrappedObj = facebook::jsi::Object::createFromHostObject(rt, wrapped);
                    descriptor.setProperty(rt, "value", std::move(wrappedObj));
                    FERRUM_LOG(@"Trapped nativeModuleProxy — FerrumModuleProxy active");
                  }
                }
              }
            }

            // Forward to real Object.defineProperty(target, name, descriptor).
            // Explicit overload selection — variadic template wins otherwise.
            using CallFn = facebook::jsi::Value (facebook::jsi::Function::*)(
                facebook::jsi::Runtime &, const facebook::jsi::Value *, size_t) const;
            return (g_realDefineProperty.get()->*static_cast<CallFn>(
                &facebook::jsi::Function::call))(rt, args, count);
          });

      Object.setProperty(rt, "defineProperty", std::move(trap));
    }

    FERRUM_LOG(@"Runtime ready");
    return jsRuntime;
  }
};

} // anonymous namespace

extern "C" void *jsrt_create_ferrum_factory(void) {
  return new FerrumRuntimeFactory();
}

// ---------------------------------------------------------------------------
// Bootstrap: swizzle createJSRuntimeFactory at +load
// ---------------------------------------------------------------------------

@interface FerrumSwizzle : NSObject
@end

@implementation FerrumSwizzle

+ (void)load {
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    Class cls = NSClassFromString(@"RCTDefaultReactNativeFactoryDelegate");
    if (!cls) return;

    SEL sel = NSSelectorFromString(@"createJSRuntimeFactory");
    Method method = class_getInstanceMethod(cls, sel);
    if (!method) return;

    IMP newIMP = imp_implementationWithBlock(^void *(id self_) {
      return jsrt_create_ferrum_factory();
    });

    method_setImplementation(method, newIMP);
    FERRUM_LOG(@"Swizzled createJSRuntimeFactory");
  });
}

@end
