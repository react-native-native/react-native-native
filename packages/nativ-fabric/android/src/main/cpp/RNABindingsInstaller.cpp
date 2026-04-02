/// RNABindingsInstaller — installs global.__nativ via TurboModuleWithJSIBindings.
/// Self-contained in rna-fabric. No dependency on expo-ferrum.

#include <fbjni/fbjni.h>
#include <jsi/jsi.h>
#include <ReactCommon/BindingsInstallerHolder.h>
#include <ReactCommon/CallInvoker.h>
#include <string>
#include <thread>
#include <android/log.h>
#include <dlfcn.h>

using namespace facebook;

#define NATIV_LOG(...) __android_log_print(ANDROID_LOG_INFO, "NativRuntime", __VA_ARGS__)

// Defined in FerrumRuntime.cpp (same .so)
extern "C" const char* nativ_call_sync(const char*, const char*, const char*);
typedef void (*RNAAsyncFn)(const char*, void (*)(const char*), void (*)(const char*, const char*));
extern "C" RNAAsyncFn nativ_get_async_fn(const char*, const char*);

static jsi::Runtime* g_runtime = nullptr;
static std::shared_ptr<react::CallInvoker> g_callInvoker = nullptr;

static void installRNA(jsi::Runtime &rt) {
  auto nativ = jsi::Object(rt);

  // __nativ.callSync(moduleId, fnName, argsJson) → string
  using CallSyncFn = const char* (*)(const char*, const char*, const char*);
  nativ.setProperty(rt, "callSync", jsi::Function::createFromHostFunction(
      rt, jsi::PropNameID::forAscii(rt, "callSync"), 3,
      [](jsi::Runtime &rt, const jsi::Value &,
         const jsi::Value *args, size_t count) -> jsi::Value {
        if (count < 3) return jsi::Value::null();

        auto moduleId = args[0].getString(rt).utf8(rt);
        auto fnName = args[1].getString(rt).utf8(rt);
        auto argsJson = args[2].getString(rt).utf8(rt);

        // Try C registry first (Rust/C++ .so modules)
        const char* result = nativ_call_sync(moduleId.c_str(), fnName.c_str(), argsJson.c_str());
        if (result) return jsi::Value(rt, jsi::String::createFromUtf8(rt, result));

        // Fall back to Kotlin dispatch (.dex modules)
        JNIEnv *env = jni::Environment::current();
        if (env && env->PushLocalFrame(16) == 0) {
          jclass rtClass = env->FindClass("com/ferrumfabric/FerrumRuntime");
          if (rtClass) {
            jfieldID instField = env->GetStaticFieldID(rtClass, "INSTANCE", "Lcom/ferrumfabric/FerrumRuntime;");
            jobject rtInst = instField ? env->GetStaticObjectField(rtClass, instField) : nullptr;
            if (rtInst) {
              jmethodID callKt = env->GetMethodID(rtClass, "callKotlin",
                  "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;");
              if (callKt) {
                jstring jMod = env->NewStringUTF(moduleId.c_str());
                jstring jFn = env->NewStringUTF(fnName.c_str());
                jstring jArgs = env->NewStringUTF(argsJson.c_str());
                auto jResult = (jstring)env->CallObjectMethod(rtInst, callKt, jMod, jFn, jArgs);
                if (jResult && !env->ExceptionCheck()) {
                  const char* chars = env->GetStringUTFChars(jResult, nullptr);
                  auto jsResult = jsi::String::createFromUtf8(rt, chars);
                  env->ReleaseStringUTFChars(jResult, chars);
                  env->PopLocalFrame(nullptr);
                  return jsi::Value(rt, jsResult);
                }
                if (env->ExceptionCheck()) env->ExceptionClear();
              }
            }
          } else { env->ExceptionClear(); }
          env->PopLocalFrame(nullptr);
        }
        return jsi::Value::null();
      }));

  // __nativ.callAsync(moduleId, fnName, argsJson) → Promise
  nativ.setProperty(rt, "callAsync", jsi::Function::createFromHostFunction(
      rt, jsi::PropNameID::forAscii(rt, "callAsync"), 3,
      [](jsi::Runtime &rt, const jsi::Value &,
         const jsi::Value *args, size_t count) -> jsi::Value {
        if (count < 3) return jsi::Value::null();

        auto moduleId = args[0].getString(rt).utf8(rt);
        auto fnName = args[1].getString(rt).utf8(rt);
        auto argsJson = args[2].getString(rt).utf8(rt);

        auto asyncFn = nativ_get_async_fn(moduleId.c_str(), fnName.c_str());
        if (!asyncFn) {
          throw jsi::JSError(rt, "Unknown RNA async function: " + moduleId + "::" + fnName);
        }

        auto Promise = rt.global().getPropertyAsFunction(rt, "Promise");
        auto executor = jsi::Function::createFromHostFunction(
            rt, jsi::PropNameID::forAscii(rt, "executor"), 2,
            [asyncFn, argsJson](jsi::Runtime &rt, const jsi::Value &,
                                const jsi::Value *pargs, size_t) -> jsi::Value {

              auto resolve = std::make_shared<jsi::Function>(pargs[0].asObject(rt).asFunction(rt));
              auto reject = std::make_shared<jsi::Function>(pargs[1].asObject(rt).asFunction(rt));
              auto invoker = g_callInvoker;

              // Same thread_local context pattern as iOS
              struct AsyncCtx {
                std::shared_ptr<jsi::Function> resolve;
                std::shared_ptr<jsi::Function> reject;
                std::shared_ptr<react::CallInvoker> invoker;
              };
              static thread_local AsyncCtx* _asyncCtx = nullptr;
              auto ctx = new AsyncCtx{resolve, reject, invoker};

              // Dispatch to background thread
              std::thread([asyncFn, argsJson, ctx]() {
                _asyncCtx = ctx;

                asyncFn(
                    argsJson.c_str(),
                    // resolve
                    [](const char* result) {
                      auto* c = _asyncCtx;
                      if (!c) return;
                      _asyncCtx = nullptr;
                      auto resultStr = std::string(result ? result : "null");
                      auto res = c->resolve;
                      auto inv = c->invoker;
                      delete c;
                      if (inv) {
                        inv->invokeAsync([res, resultStr]() {
                          auto &rt = *g_runtime;
                          auto json = rt.global().getPropertyAsObject(rt, "JSON");
                          auto parse = json.getPropertyAsFunction(rt, "parse");
                          auto parsed = parse.call(rt, jsi::String::createFromUtf8(rt, resultStr));
                          res->call(rt, std::move(parsed));
                        });
                      }
                    },
                    // reject
                    [](const char* code, const char* msg) {
                      auto* c = _asyncCtx;
                      if (!c) return;
                      _asyncCtx = nullptr;
                      auto msgStr = std::string(msg ? msg : "Unknown error");
                      auto rej = c->reject;
                      auto inv = c->invoker;
                      delete c;
                      if (inv) {
                        inv->invokeAsync([rej, msgStr]() {
                          auto &rt = *g_runtime;
                          rej->call(rt, jsi::String::createFromUtf8(rt, msgStr));
                        });
                      }
                    });
              }).detach();

              return jsi::Value::undefined();
            });

        return Promise.callAsConstructor(rt, executor);
      }));

  // __nativ.setComponentProps(componentId, props)
  nativ.setProperty(rt, "setComponentProps", jsi::Function::createFromHostFunction(
      rt, jsi::PropNameID::forAscii(rt, "setComponentProps"), 2,
      [](jsi::Runtime &rt, const jsi::Value &,
         const jsi::Value *args, size_t count) -> jsi::Value {
        if (count < 2 || !args[0].isString()) return jsi::Value::undefined();
        JNIEnv *env = jni::Environment::current();
        if (!env) return jsi::Value::undefined();
        if (env->PushLocalFrame(128) != 0) return jsi::Value::undefined();

        auto componentId = args[0].getString(rt).utf8(rt);

        jclass hmClass = env->FindClass("java/util/HashMap");
        if (!hmClass) { env->PopLocalFrame(nullptr); return jsi::Value::undefined(); }
        jmethodID hmInit = env->GetMethodID(hmClass, "<init>", "()V");
        jmethodID hmPut = env->GetMethodID(hmClass, "put",
            "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;");

        jobject strings = env->NewObject(hmClass, hmInit);
        jobject numbers = env->NewObject(hmClass, hmInit);
        jobject bools = env->NewObject(hmClass, hmInit);

        jclass dblClass = env->FindClass("java/lang/Double");
        jmethodID dblOf = env->GetStaticMethodID(dblClass, "valueOf", "(D)Ljava/lang/Double;");
        jclass boolClass = env->FindClass("java/lang/Boolean");
        jmethodID boolOf = env->GetStaticMethodID(boolClass, "valueOf", "(Z)Ljava/lang/Boolean;");

        if (args[1].isObject()) {
          auto obj = args[1].asObject(rt);
          auto names = obj.getPropertyNames(rt);
          for (size_t i = 0; i < names.size(rt); i++) {
            auto propName = names.getValueAtIndex(rt, i).getString(rt).utf8(rt);
            if (propName.empty()) continue;
            auto val = obj.getProperty(rt, propName.c_str());
            jstring jKey = env->NewStringUTF(propName.c_str());
            if (!jKey) continue;

            if (val.isString()) {
              auto sval = val.getString(rt).utf8(rt);
              jstring jVal = env->NewStringUTF(sval.c_str());
              if (jVal) env->CallObjectMethod(strings, hmPut, jKey, jVal);
            } else if (val.isNumber()) {
              jobject jVal = env->CallStaticObjectMethod(dblClass, dblOf, val.getNumber());
              env->CallObjectMethod(numbers, hmPut, jKey, jVal);
            } else if (val.isBool()) {
              jobject jVal = env->CallStaticObjectMethod(boolClass, boolOf, (jboolean)val.getBool());
              env->CallObjectMethod(bools, hmPut, jKey, jVal);
            }
          }
        }

        jclass rtClass = env->FindClass("com/ferrumfabric/FerrumRuntime");
        if (rtClass) {
          jfieldID instField = env->GetStaticFieldID(rtClass, "INSTANCE",
              "Lcom/ferrumfabric/FerrumRuntime;");
          jobject rtInst = instField ? env->GetStaticObjectField(rtClass, instField) : nullptr;

          jclass psClass = env->FindClass("com/ferrumfabric/FerrumRuntime$PropsSnapshot");
          if (psClass && rtInst) {
            jmethodID psInit = env->GetMethodID(psClass, "<init>",
                "(Ljava/util/Map;Ljava/util/Map;Ljava/util/Map;)V");
            jobject snapshot = env->NewObject(psClass, psInit, strings, numbers, bools);

            jmethodID setProps = env->GetMethodID(rtClass, "setComponentProps",
                "(Ljava/lang/String;Lcom/ferrumfabric/FerrumRuntime$PropsSnapshot;)V");
            jstring jCompId = env->NewStringUTF(componentId.c_str());
            if (jCompId && snapshot && setProps) {
              env->CallVoidMethod(rtInst, setProps, jCompId, snapshot);
            }
          }
        }

        if (env->ExceptionCheck()) env->ExceptionClear();
        env->PopLocalFrame(nullptr);
        return jsi::Value::undefined();
      }));

#ifndef NATIV_RELEASE
  // __nativ.loadDylib(url) — dev only, downloads .so/.dex from Metro
  nativ.setProperty(rt, "loadDylib", jsi::Function::createFromHostFunction(
      rt, jsi::PropNameID::forAscii(rt, "loadDylib"), 1,
      [](jsi::Runtime &rt, const jsi::Value &,
         const jsi::Value *args, size_t count) -> jsi::Value {
        if (count < 1 || !args[0].isString()) return jsi::Value(false);
        auto url = args[0].getString(rt).utf8(rt);
        bool isDex = url.find(".dex") != std::string::npos;

        JNIEnv *env = jni::Environment::current();
        if (!env) return jsi::Value(false);
        if (env->PushLocalFrame(64) != 0) return jsi::Value(false);

        // Download via java.net.URL
        jclass urlClass = env->FindClass("java/net/URL");
        jmethodID urlInit = env->GetMethodID(urlClass, "<init>", "(Ljava/lang/String;)V");
        jmethodID openStream = env->GetMethodID(urlClass, "openStream", "()Ljava/io/InputStream;");
        jstring jUrl = env->NewStringUTF(url.c_str());
        jobject urlObj = env->NewObject(urlClass, urlInit, jUrl);
        if (env->ExceptionCheck()) { env->ExceptionClear(); env->PopLocalFrame(nullptr); return jsi::Value(false); }

        jobject stream = env->CallObjectMethod(urlObj, openStream);
        if (env->ExceptionCheck() || !stream) { env->ExceptionClear(); env->PopLocalFrame(nullptr); return jsi::Value(false); }

        // Read into ByteArrayOutputStream
        jclass isClass = env->FindClass("java/io/InputStream");
        jclass baosClass = env->FindClass("java/io/ByteArrayOutputStream");
        jobject baos = env->NewObject(baosClass, env->GetMethodID(baosClass, "<init>", "()V"));
        jbyteArray buf = env->NewByteArray(8192);
        jmethodID readM = env->GetMethodID(isClass, "read", "([B)I");
        jmethodID writeM = env->GetMethodID(baosClass, "write", "([BII)V");
        while (true) {
          jint n = env->CallIntMethod(stream, readM, buf);
          if (n <= 0) break;
          env->CallVoidMethod(baos, writeM, buf, 0, n);
        }
        env->CallVoidMethod(stream, env->GetMethodID(isClass, "close", "()V"));
        auto bytes = (jbyteArray)env->CallObjectMethod(baos, env->GetMethodID(baosClass, "toByteArray", "()[B"));
        jsize len = env->GetArrayLength(bytes);

        // Write to temp file
        jclass fileClass = env->FindClass("java/io/File");
        jstring prefix = env->NewStringUTF("nativ_");
        jstring suffix = env->NewStringUTF(isDex ? ".dex" : ".so");
        jobject tmpFile = env->CallStaticObjectMethod(fileClass,
            env->GetStaticMethodID(fileClass, "createTempFile", "(Ljava/lang/String;Ljava/lang/String;)Ljava/io/File;"),
            prefix, suffix);
        if (env->ExceptionCheck()) { env->ExceptionClear(); env->PopLocalFrame(nullptr); return jsi::Value(false); }

        jclass fosClass = env->FindClass("java/io/FileOutputStream");
        jobject fos = env->NewObject(fosClass, env->GetMethodID(fosClass, "<init>", "(Ljava/io/File;)V"), tmpFile);
        env->CallVoidMethod(fos, env->GetMethodID(fosClass, "write", "([B)V"), bytes);
        env->CallVoidMethod(fos, env->GetMethodID(fosClass, "close", "()V"));

        auto jPath = (jstring)env->CallObjectMethod(tmpFile,
            env->GetMethodID(fileClass, "getAbsolutePath", "()Ljava/lang/String;"));
        const char *pathChars = env->GetStringUTFChars(jPath, nullptr);
        std::string filePath(pathChars);
        env->ReleaseStringUTFChars(jPath, pathChars);

        bool ok = false;
        if (isDex) {
          auto lastSlash = url.rfind('/');
          auto dotDex = url.rfind(".dex");
          std::string moduleId = (lastSlash != std::string::npos && dotDex != std::string::npos)
              ? url.substr(lastSlash + 1, dotDex - lastSlash - 1) : "";
          if (moduleId.substr(0, 7) == "nativ_") moduleId = moduleId.substr(7);
          auto lastUs = moduleId.rfind('_');
          if (lastUs != std::string::npos && moduleId.length() - lastUs - 1 == 8) {
            moduleId = moduleId.substr(0, lastUs);
          }

          jclass rtClass = env->FindClass("com/ferrumfabric/FerrumRuntime");
          jfieldID instField = env->GetStaticFieldID(rtClass, "INSTANCE", "Lcom/ferrumfabric/FerrumRuntime;");
          jobject rtInst = instField ? env->GetStaticObjectField(rtClass, instField) : nullptr;
          if (rtInst) {
            jmethodID loadDex = env->GetMethodID(rtClass, "loadDex", "(Ljava/lang/String;Ljava/lang/String;)Z");
            jstring jFilePath = env->NewStringUTF(filePath.c_str());
            jstring jModuleId = env->NewStringUTF(moduleId.c_str());
            ok = env->CallBooleanMethod(rtInst, loadDex, jFilePath, jModuleId);
            if (env->ExceptionCheck()) { env->ExceptionClear(); ok = false; }
          }
        } else {
          env->CallBooleanMethod(tmpFile,
              env->GetMethodID(fileClass, "setExecutable", "(Z)Z"), (jboolean)true);
          void *handle = dlopen(filePath.c_str(), RTLD_NOW);
          ok = (handle != nullptr);
          if (ok) {
            using InitFn = void (*)(void*);
            void *rtLib = dlopen("libnativruntime.so", RTLD_NOW | RTLD_NOLOAD);
            if (rtLib) {
              auto setLib = (InitFn)dlsym(handle, "nativ_set_runtime_lib");
              if (setLib) setLib(rtLib);
              auto initFn = (InitFn)dlsym(handle, "nativ_init");
              if (initFn) {
                void *regFn = dlsym(rtLib, "nativ_register_sync");
                if (regFn) initFn(regFn);
              }
              auto renderInitFn = (InitFn)dlsym(handle, "nativ_init_render");
              if (renderInitFn) {
                void *renderRegFn = dlsym(rtLib, "nativ_register_render");
                if (renderRegFn) renderInitFn(renderRegFn);
              }
            }
          } else {
            NATIV_LOG("loadDylib: dlopen failed: %s", dlerror());
          }
        }

        NATIV_LOG("loadDylib: %s → %s (%d bytes)", url.c_str(), ok ? "OK" : "FAIL", (int)len);
        env->PopLocalFrame(nullptr);
        return jsi::Value(ok);
      }));
#endif // !NATIV_RELEASE

  // ABI target — used by JS shim to request correct dylib from Metro
#if defined(__aarch64__)
  nativ.setProperty(rt, "target", jsi::String::createFromUtf8(rt, "arm64-v8a"));
#elif defined(__arm__)
  nativ.setProperty(rt, "target", jsi::String::createFromUtf8(rt, "armeabi-v7a"));
#elif defined(__x86_64__)
  nativ.setProperty(rt, "target", jsi::String::createFromUtf8(rt, "x86_64"));
#elif defined(__i386__)
  nativ.setProperty(rt, "target", jsi::String::createFromUtf8(rt, "x86"));
#endif

  rt.global().setProperty(rt, "__nativ", std::move(nativ));
  NATIV_LOG("global.__nativ installed via TurboModuleWithJSIBindings");
}

// ─── JNI BindingsInstallerHolder for TurboModuleWithJSIBindings ────────

struct RNARuntimeJSIBindings : public jni::JavaClass<RNARuntimeJSIBindings> {
  static constexpr const char *kJavaDescriptor = "Lcom/ferrumfabric/RNARuntimeModule;";

  static void registerNatives() {
    javaClassLocal()->registerNatives({
        makeNativeMethod("getBindingsInstaller", RNARuntimeJSIBindings::getBindingsInstaller),
    });
  }

  static jni::local_ref<react::BindingsInstallerHolder::javaobject>
  getBindingsInstaller(jni::alias_ref<RNARuntimeJSIBindings> /*jobj*/) {
    return react::BindingsInstallerHolder::newObjectCxxArgs(
        [](jsi::Runtime &runtime, const std::shared_ptr<react::CallInvoker> &callInvoker) {
          g_callInvoker = callInvoker;
          g_runtime = &runtime;
          installRNA(runtime);
        });
  }
};

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM *vm, void *) {
  return jni::initialize(vm, [] {
    RNARuntimeJSIBindings::registerNatives();
  });
}
