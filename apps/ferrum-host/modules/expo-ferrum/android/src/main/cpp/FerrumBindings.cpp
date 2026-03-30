/// Ferrum Android — Object.defineProperty trap + FerrumModuleProxy.
/// Installed via BindingsInstaller before nativeModuleProxy is defined.

#include <fbjni/fbjni.h>
#include <jsi/jsi.h>
#include <string>
#include <unordered_map>
#include <functional>
#include <android/log.h>

using namespace facebook;

#define FERRUM_LOG(...) __android_log_print(ANDROID_LOG_INFO, "Ferrum", __VA_ARGS__)

// ---------------------------------------------------------------------------
// Minimal BindingsInstaller interface — the prefab doesn't export the header.
// Matches react/runtime/BindingsInstaller.h's virtual method.
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
// FerrumModuleProxy — HostObject wrapping nativeModuleProxy
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
    auto ownNames = moduleObj.getPropertyNames(rt);
    for (size_t i = 0; i < ownNames.size(rt); i++) {
      auto oname = ownNames.getValueAtIndex(rt, i).getString(rt);
      auto oid = jsi::PropNameID::forString(rt, oname);
      freshObj.setProperty(rt, oid, moduleObj.getProperty(rt, oid));
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
// Install: Object.defineProperty trap
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

  // __ferrumGetJSIModule — fresh object with invokeJavaMethod functions copied
  // from the prototype. Same functions as stock RN, but on an optimized plain
  // object. Measures invokeJavaMethod cost without hidden class penalty.
  auto jsiGetter = jsi::Function::createFromHostFunction(
      rt, jsi::PropNameID::forAscii(rt, "__ferrumGetJSIModule"), 1,
      [](jsi::Runtime &rt, const jsi::Value &,
         const jsi::Value *args, size_t count) -> jsi::Value {
        if (count < 1 || !args[0].isString() || !g_originalProxy)
          return jsi::Value::null();
        std::string name = args[0].getString(rt).utf8(rt);
        auto moduleVal = g_originalProxy->get(rt,
            jsi::PropNameID::forUtf8(rt, name));
        if (!moduleVal.isObject()) return jsi::Value::null();

        auto moduleObj = moduleVal.asObject(rt);
        auto freshObj = jsi::Object(rt);

        // Copy prototype methods (invokeJavaMethod stubs)
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
// JNI bridge: FerrumBindingsInstaller
// ---------------------------------------------------------------------------
// Maps to com.facebook.react.runtime.BindingsInstaller via parent class.
// JReactInstance calls cthis()->getBindingsInstallFunc() on this object.
// We extend BindingsInstallerCompat which matches the vtable layout.

struct FerrumBindingsInstaller
    : public jni::HybridClass<FerrumBindingsInstaller>,
      public BindingsInstallerCompat {

  static constexpr auto kJavaDescriptor =
      "Lexpo/modules/ferrum/FerrumBindingsInstaller;";

  BindingsInstallFunc getBindingsInstallFunc() override {
    return [](jsi::Runtime &runtime) {
      installFerrum(runtime);
    };
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
