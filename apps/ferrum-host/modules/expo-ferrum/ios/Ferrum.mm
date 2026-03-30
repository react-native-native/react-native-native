/// Ferrum — TurboModule acceleration for React Native.
///
/// Bypasses NSInvocation with typed objc_msgSend, registered as JSI host
/// functions. Zero vendored Hermes changes. Pure JSI + ObjC runtime.
///
/// Boot sequence:
/// 1. +load swizzles createJSRuntimeFactory to inject FerrumRuntimeFactory
/// 2. Factory creates standard HermesRuntime, installs __ferrumGetModule
/// 3. JS calls __ferrumGetModule("ModuleName")
/// 4. We get the TurboModule instance from nativeModuleProxy
/// 5. Scan ObjC methods, build typed objc_msgSend dispatch for each
/// 6. Return a new JS object with accelerated methods

#import <Foundation/Foundation.h>
#import <objc/runtime.h>
#import <objc/message.h>
#include <react/runtime/JSRuntimeFactory.h>
#include <hermes/hermes.h>
#include <jsi/jsi.h>
#include <string>

// For ObjCTurboModule::instance_ extraction
#include <ReactCommon/TurboModule.h>
#include <ReactCommon/RCTTurboModule.h>
#include <ReactCommon/CallInvoker.h>

#import "FerrumFFIDispatch.h"

// Default Hermes factory
extern "C" void *jsrt_create_hermes_factory(void);

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

    // Capture CallInvoker for async callback dispatch
    // Re-capture on every extraction — handles JS reload where the
    // old CallInvoker points to a dead runtime.
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
// __ferrumGetModule — discovers methods, builds typed objc_msgSend dispatch
// ---------------------------------------------------------------------------

static facebook::jsi::Value ferrumGetModule(
    facebook::jsi::Runtime &runtime,
    const facebook::jsi::Value &thisVal,
    const facebook::jsi::Value *args,
    size_t count) {

  if (count < 1 || !args[0].isString())
    return facebook::jsi::Value::null();

  std::string moduleName = args[0].getString(runtime).utf8(runtime);

  auto nativeProxy = runtime.global().getProperty(runtime, "nativeModuleProxy");
  if (!nativeProxy.isObject()) return facebook::jsi::Value::null();

  auto moduleVal = nativeProxy.asObject(runtime).getProperty(runtime, moduleName.c_str());
  if (!moduleVal.isObject()) return facebook::jsi::Value::null();

  auto moduleObj = moduleVal.asObject(runtime);
  id objcInstance = extractObjCInstance(runtime, moduleObj);
  if (!objcInstance) return facebook::jsi::Value::null();

  NSLog(@"[Ferrum] Building module for '%s'", moduleName.c_str());

  auto ferrumObj = facebook::jsi::Object(runtime);
  int methodsRegistered = 0;

  Class cls = [objcInstance class];
  while (cls && cls != [NSObject class]) {
    unsigned int methodCount = 0;
    Method *methods = class_copyMethodList(cls, &methodCount);
    for (unsigned int i = 0; i < methodCount; i++) {
      SEL sel = method_getName(methods[i]);
      NSString *selName = NSStringFromSelector(sel);

      // Skip internal methods
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

      // Build typed dispatch info
      FerrumDispatchInfo *info = ferrum_dispatch_build(objcInstance, sel, (unsigned int)argCount);
      if (!info) continue;

      NSString *jsName = [selName componentsSeparatedByString:@":"][0];
      auto sharedInfo = std::make_shared<FerrumDispatchInfo>(*info);
      ferrum_dispatch_free(info);

      // Register as JSI host function — typed objc_msgSend inside
      auto fn = facebook::jsi::Function::createFromHostFunction(
          runtime,
          facebook::jsi::PropNameID::forAscii(runtime, [jsName UTF8String]),
          (unsigned int)argCount,
          [sharedInfo](
              facebook::jsi::Runtime &rt,
              const facebook::jsi::Value &,
              const facebook::jsi::Value *jsiArgs,
              size_t cnt) -> facebook::jsi::Value {
            return ferrum_dispatch_call_jsi(sharedInfo.get(), rt, jsiArgs, cnt);
          });

      ferrumObj.setProperty(runtime, [jsName UTF8String], std::move(fn));
      methodsRegistered++;
    }
    free(methods);
    cls = class_getSuperclass(cls);
  }

  NSLog(@"[Ferrum] '%s': %d methods", moduleName.c_str(), methodsRegistered);
  return facebook::jsi::Value(runtime, ferrumObj);
}

// ---------------------------------------------------------------------------
// FerrumModuleProxy — HostObject that wraps nativeModuleProxy
// ---------------------------------------------------------------------------
// Intercepts property access: builds Ferrum-accelerated module on first access,
// caches it, falls back to original for modules it can't handle.

class FerrumModuleProxy : public facebook::jsi::HostObject {
  // The original nativeModuleProxy HostObject
  std::shared_ptr<facebook::jsi::HostObject> original_;
  // Cache of accelerated modules
  std::unordered_map<std::string, facebook::jsi::Value> cache_;

public:
  FerrumModuleProxy(std::shared_ptr<facebook::jsi::HostObject> original)
      : original_(std::move(original)) {}

  facebook::jsi::Value get(facebook::jsi::Runtime &rt,
                           const facebook::jsi::PropNameID &name) override {
    std::string propName = name.utf8(rt);

    // Check cache
    auto it = cache_.find(propName);
    if (it != cache_.end()) {
      return facebook::jsi::Value(rt, it->second);
    }

    // Try building a Ferrum module
    auto args = facebook::jsi::String::createFromUtf8(rt, propName);
    auto asVal = facebook::jsi::Value(rt, args);
    auto result = ferrumGetModule(rt, facebook::jsi::Value::undefined(), &asVal, 1);

    if (!result.isNull() && !result.isUndefined()) {
      cache_.emplace(propName, facebook::jsi::Value(rt, result.asObject(rt)));
      return result;
    }

    // Fall back to original
    return original_->get(rt, name);
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

    // Install __ferrumGetModule for explicit use / benchmarking
    auto getter = facebook::jsi::Function::createFromHostFunction(
        rt,
        facebook::jsi::PropNameID::forAscii(rt, "__ferrumGetModule"),
        1,
        ferrumGetModule);
    rt.global().setProperty(rt, "__ferrumGetModule", getter);

    NSLog(@"[Ferrum] __ferrumGetModule installed");

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
    NSLog(@"[Ferrum] Swizzled createJSRuntimeFactory");

  });
}

@end
