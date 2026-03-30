/// Ferrum Android — Object.defineProperty trap + FerrumModuleProxy + JNI FFI.
/// Phase 1: fresh objects (hidden class fix).
/// Phase 2: pre-resolved JNI dispatch (replaces invokeJavaMethod ceremony).

#include <fbjni/fbjni.h>
#include <jsi/jsi.h>
#include <string>
#include <unordered_map>
#include <functional>
#include <android/log.h>

#include "FerrumJNIDispatch.h"

using namespace facebook;

#define FERRUM_LOG(...) __android_log_print(ANDROID_LOG_INFO, "Ferrum", __VA_ARGS__)

// ---------------------------------------------------------------------------
// Minimal BindingsInstaller interface
// ---------------------------------------------------------------------------

using BindingsInstallFunc = std::function<void(jsi::Runtime &runtime)>;

class BindingsInstallerCompat {
public:
  virtual BindingsInstallFunc getBindingsInstallFunc() { return nullptr; }
  virtual ~BindingsInstallerCompat() = default;
};

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------

static std::shared_ptr<jsi::HostObject> g_originalProxy = nullptr;
static std::shared_ptr<jsi::Function> g_realDefineProperty = nullptr;

// ---------------------------------------------------------------------------
// Java instance extraction via Kotlin helper
// ---------------------------------------------------------------------------
// We can't include JavaTurboModule.h (pulls in folly which isn't in prefab).
// Instead, the Kotlin side provides the Java module instance by name
// via the TurboModuleManager.

static jobject getJavaModuleInstance(JNIEnv *env, const std::string &moduleName) {
  // Call FerrumModuleProvider.getModuleInstance(moduleName)
  jclass providerCls = env->FindClass("expo/modules/ferrum/FerrumModuleProvider");
  if (!providerCls) { env->ExceptionClear(); return nullptr; }

  jmethodID getInst = env->GetStaticMethodID(providerCls,
      "getModuleInstance",
      "(Ljava/lang/String;)Ljava/lang/Object;");
  if (!getInst) { env->ExceptionClear(); env->DeleteLocalRef(providerCls); return nullptr; }

  jstring jName = env->NewStringUTF(moduleName.c_str());
  jobject instance = env->CallStaticObjectMethod(providerCls, getInst, jName);
  env->DeleteLocalRef(jName);
  env->DeleteLocalRef(providerCls);

  if (env->ExceptionCheck()) { env->ExceptionClear(); return nullptr; }
  return instance;
}

// ---------------------------------------------------------------------------
// Overlay FFI methods using Kotlin-side method resolution
// ---------------------------------------------------------------------------

static int ferrumOverlayJNI(jsi::Runtime &rt, jsi::Object &freshObj,
                             jobject javaInstance) {
  JNIEnv *env = jni::Environment::current();
  if (!env || !javaInstance) return 0;

  // Call Kotlin: FerrumMethodResolver.resolveMethodsForClass(instance.getClass())
  jclass resolverCls = env->FindClass("expo/modules/ferrum/FerrumMethodResolver");
  if (!resolverCls) { env->ExceptionClear(); return 0; }

  jmethodID resolveMethods = env->GetStaticMethodID(resolverCls,
      "resolveMethodsForClass",
      "(Ljava/lang/Class;)[Lexpo/modules/ferrum/FerrumMethodResolver$MethodInfo;");
  if (!resolveMethods) { env->ExceptionClear(); return 0; }

  jclass instanceClass = env->GetObjectClass(javaInstance);
  auto methodInfoArray = (jobjectArray)env->CallStaticObjectMethod(
      resolverCls, resolveMethods, instanceClass);
  env->DeleteLocalRef(instanceClass);
  if (!methodInfoArray) { env->ExceptionClear(); return 0; }

  // Get MethodInfo field IDs
  jclass methodInfoCls = env->FindClass("expo/modules/ferrum/FerrumMethodResolver$MethodInfo");
  jfieldID fName = env->GetFieldID(methodInfoCls, "name", "Ljava/lang/String;");
  jfieldID fSig = env->GetFieldID(methodInfoCls, "jniSignature", "Ljava/lang/String;");
  jfieldID fRetKind = env->GetFieldID(methodInfoCls, "returnKind", "I");
  jfieldID fArgCount = env->GetFieldID(methodInfoCls, "jsArgCount", "I");

  int accelerated = 0;
  jsize len = env->GetArrayLength(methodInfoArray);

  for (jsize i = 0; i < len; i++) {
    jobject mi = env->GetObjectArrayElement(methodInfoArray, i);
    auto jName = (jstring)env->GetObjectField(mi, fName);
    auto jSig = (jstring)env->GetObjectField(mi, fSig);
    int retKind = env->GetIntField(mi, fRetKind);
    int argCount = env->GetIntField(mi, fArgCount);

    const char *name = env->GetStringUTFChars(jName, nullptr);
    const char *sig = env->GetStringUTFChars(jSig, nullptr);

    // Skip getConstants (same as iOS)
    if (strcmp(name, "getConstants") == 0) {
      env->ReleaseStringUTFChars(jName, name);
      env->ReleaseStringUTFChars(jSig, sig);
      env->DeleteLocalRef(jName);
      env->DeleteLocalRef(jSig);
      env->DeleteLocalRef(mi);
      continue;
    }

    // Build pre-resolved dispatch info
    auto *info = ferrum_jni_dispatch_build(env, javaInstance, name, sig, retKind, argCount);

    if (info) {
      auto sharedInfo = std::shared_ptr<FerrumJNIDispatchInfo>(info, ferrum_jni_dispatch_free);
      std::string jsName(name);

      auto fn = jsi::Function::createFromHostFunction(
          rt,
          jsi::PropNameID::forUtf8(rt, jsName),
          (unsigned int)argCount,
          [sharedInfo](jsi::Runtime &rt2, const jsi::Value &,
                       const jsi::Value *args, size_t cnt) -> jsi::Value {
            JNIEnv *env2 = jni::Environment::current();
            return sharedInfo->callFn(sharedInfo.get(), env2, rt2, args, cnt);
          });

      freshObj.setProperty(rt, jsName.c_str(), std::move(fn));
      accelerated++;
    }

    env->ReleaseStringUTFChars(jName, name);
    env->ReleaseStringUTFChars(jSig, sig);
    env->DeleteLocalRef(jName);
    env->DeleteLocalRef(jSig);
    env->DeleteLocalRef(mi);
  }

  env->DeleteLocalRef(methodInfoArray);
  env->DeleteLocalRef(resolverCls);
  env->DeleteLocalRef(methodInfoCls);

  return accelerated;
}

// ---------------------------------------------------------------------------
// FerrumModuleProxy
// ---------------------------------------------------------------------------

class FerrumModuleProxy : public jsi::HostObject {
  std::shared_ptr<jsi::HostObject> original_;
  std::unordered_map<std::string, std::shared_ptr<jsi::Object>> cache_;

public:
  FerrumModuleProxy(std::shared_ptr<jsi::HostObject> original)
      : original_(std::move(original)) {}

  jsi::Value get(jsi::Runtime &rt, const jsi::PropNameID &name) override {
    std::string propName = name.utf8(rt);

    auto it = cache_.find(propName);
    if (it != cache_.end()) {
      return jsi::Value(rt, *it->second);
    }

    auto moduleVal = original_->get(rt, name);
    if (!moduleVal.isObject()) return moduleVal;

    auto moduleObj = moduleVal.asObject(rt);

    // Build a FRESH plain object — avoids Hermes hidden class deoptimization
    auto freshObj = jsi::Object(rt);

    // Copy prototype methods (invokeJavaMethod stubs) as baseline
    auto Object = rt.global().getPropertyAsObject(rt, "Object");
    auto getProto = Object.getPropertyAsFunction(rt, "getPrototypeOf");
    auto protoVal = getProto.call(rt, moduleObj);
    if (protoVal.isObject()) {
      auto proto = protoVal.asObject(rt);
      auto protoNames = proto.getPropertyNames(rt);
      for (size_t i = 0; i < protoNames.size(rt); i++) {
        auto pname = protoNames.getValueAtIndex(rt, i).getString(rt);
        auto pid = jsi::PropNameID::forString(rt, pname);
        freshObj.setProperty(rt, pid, proto.getProperty(rt, pid));
      }
    }
    // Copy own properties
    auto ownNames = moduleObj.getPropertyNames(rt);
    for (size_t i = 0; i < ownNames.size(rt); i++) {
      auto oname = ownNames.getValueAtIndex(rt, i).getString(rt);
      auto oid = jsi::PropNameID::forString(rt, oname);
      freshObj.setProperty(rt, oid, moduleObj.getProperty(rt, oid));
    }

    // Phase 2: overlay JNI FFI dispatch on top
    JNIEnv *env = jni::Environment::current();
    if (env) {
      // Reserve local ref capacity for the overlay (class lookups, strings, etc.)
      if (env->PushLocalFrame(64) == 0) {
        jobject javaInstance = getJavaModuleInstance(env, propName);
        if (javaInstance) {
          int n = ferrumOverlayJNI(rt, freshObj, javaInstance);
          FERRUM_LOG("'%s': %d methods accelerated", propName.c_str(), n);
        }
        env->PopLocalFrame(nullptr);
      }
    }

    auto cached = std::make_shared<jsi::Object>(std::move(freshObj));
    cache_.emplace(propName, cached);
    return jsi::Value(rt, *cached);
  }

  void set(jsi::Runtime &rt, const jsi::PropNameID &name,
           const jsi::Value &value) override {
    original_->set(rt, name, value);
  }

  std::vector<jsi::PropNameID> getPropertyNames(jsi::Runtime &rt) override {
    return original_->getPropertyNames(rt);
  }
};

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

static void installFerrum(jsi::Runtime &rt) {
  g_originalProxy = nullptr;
  g_realDefineProperty = nullptr;

  auto Object = rt.global().getPropertyAsObject(rt, "Object");
  auto realDP = Object.getPropertyAsFunction(rt, "defineProperty");
  g_realDefineProperty = std::make_shared<jsi::Function>(std::move(realDP));

  auto trap = jsi::Function::createFromHostFunction(
      rt, jsi::PropNameID::forAscii(rt, "defineProperty"), 3,
      [](jsi::Runtime &rt, const jsi::Value &,
         const jsi::Value *args, size_t count) -> jsi::Value {

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
                auto wrappedObj = jsi::Object::createFromHostObject(rt, wrapped);
                descriptor.setProperty(rt, "value", std::move(wrappedObj));
                FERRUM_LOG("Trapped nativeModuleProxy — FerrumModuleProxy active");
              }
            }
          }
        }

        using CallFn = jsi::Value (jsi::Function::*)(
            jsi::Runtime &, const jsi::Value *, size_t) const;
        return (g_realDefineProperty.get()->*static_cast<CallFn>(
            &jsi::Function::call))(rt, args, count);
      });

  Object.setProperty(rt, "defineProperty", std::move(trap));

  // __ferrumGetJSIModule
  auto jsiGetter = jsi::Function::createFromHostFunction(
      rt, jsi::PropNameID::forAscii(rt, "__ferrumGetJSIModule"), 1,
      [](jsi::Runtime &rt, const jsi::Value &,
         const jsi::Value *args, size_t count) -> jsi::Value {
        if (count < 1 || !args[0].isString() || !g_originalProxy)
          return jsi::Value::null();
        std::string name = args[0].getString(rt).utf8(rt);
        auto moduleVal = g_originalProxy->get(rt, jsi::PropNameID::forUtf8(rt, name));
        if (!moduleVal.isObject()) return jsi::Value::null();
        auto moduleObj = moduleVal.asObject(rt);
        auto freshObj = jsi::Object(rt);
        auto Object = rt.global().getPropertyAsObject(rt, "Object");
        auto getProto = Object.getPropertyAsFunction(rt, "getPrototypeOf");
        auto protoVal = getProto.call(rt, moduleObj);
        if (protoVal.isObject()) {
          auto proto = protoVal.asObject(rt);
          auto names = proto.getPropertyNames(rt);
          for (size_t i = 0; i < names.size(rt); i++) {
            auto pname = names.getValueAtIndex(rt, i).getString(rt);
            auto pid = jsi::PropNameID::forString(rt, pname);
            freshObj.setProperty(rt, pid, proto.getProperty(rt, pid));
          }
        }
        auto ownNames = moduleObj.getPropertyNames(rt);
        for (size_t i = 0; i < ownNames.size(rt); i++) {
          auto oname = ownNames.getValueAtIndex(rt, i).getString(rt);
          auto oid = jsi::PropNameID::forString(rt, oname);
          freshObj.setProperty(rt, oid, moduleObj.getProperty(rt, oid));
        }
        return jsi::Value(rt, freshObj);
      });
  rt.global().setProperty(rt, "__ferrumGetJSIModule", std::move(jsiGetter));

  FERRUM_LOG("Runtime ready (Android)");
}

// ---------------------------------------------------------------------------
// JNI bridge
// ---------------------------------------------------------------------------

struct FerrumBindingsInstaller
    : public jni::HybridClass<FerrumBindingsInstaller>,
      public BindingsInstallerCompat {

  static constexpr auto kJavaDescriptor =
      "Lexpo/modules/ferrum/FerrumBindingsInstaller;";

  BindingsInstallFunc getBindingsInstallFunc() override {
    return [](jsi::Runtime &runtime) { installFerrum(runtime); };
  }

  static jni::local_ref<jhybriddata> initHybrid(jni::alias_ref<javaobject>) {
    return makeCxxInstance();
  }

  static void registerNatives() {
    registerHybrid({
        makeNativeMethod("initHybrid", FerrumBindingsInstaller::initHybrid),
    });
  }
};

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM *vm, void *) {
  return jni::initialize(vm, [] {
    FerrumBindingsInstaller::registerNatives();
  });
}
