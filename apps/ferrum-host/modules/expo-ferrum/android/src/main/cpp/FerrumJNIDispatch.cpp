/// FerrumJNIDispatch — pre-resolved JNI dispatch.
/// Eliminates per-call: signature parsing, JNIArgs allocation, vector<jvalue>,
/// perf logger, JniLocalScope, checkJNIError try/catch.

#include "FerrumJNIDispatch.h"
#include <jsi/jsi.h>
#include <fbjni/fbjni.h>
#include <fbjni/NativeRunnable.h>
#include <android/log.h>
#include <string>
#include <cstring>

using namespace facebook;

// ---------------------------------------------------------------------------
// JSI → jvalue conversion (inline, no string comparisons at call time)
// ---------------------------------------------------------------------------

static inline jvalue jsiToJValue(JNIEnv *env, jsi::Runtime &rt,
                                  const jsi::Value &v, char type) {
  jvalue jv = {};
  switch (type) {
    case 'D': jv.d = v.getNumber(); break;
    case 'F': jv.f = (float)v.getNumber(); break;
    case 'I': jv.i = (int)v.getNumber(); break;
    case 'Z': jv.z = (jboolean)v.getBool(); break;
    case 'L': {
      // Object arg: string, map, array, callback, etc.
      if (v.isNull() || v.isUndefined()) {
        jv.l = nullptr;
      } else if (v.isString()) {
        jv.l = env->NewStringUTF(v.getString(rt).utf8(rt).c_str());
      } else if (v.isBool()) {
        // Boxed Boolean
        jclass cls = env->FindClass("java/lang/Boolean");
        jmethodID valueOf = env->GetStaticMethodID(cls, "valueOf", "(Z)Ljava/lang/Boolean;");
        jv.l = env->CallStaticObjectMethod(cls, valueOf, (jboolean)v.getBool());
      } else if (v.isNumber()) {
        // Boxed Double
        jclass cls = env->FindClass("java/lang/Double");
        jmethodID valueOf = env->GetStaticMethodID(cls, "valueOf", "(D)Ljava/lang/Double;");
        jv.l = env->CallStaticObjectMethod(cls, valueOf, v.getNumber());
      } else {
        // TODO: ReadableMap, ReadableArray, Callback — needs folly::dynamic conversion
        jv.l = nullptr;
      }
      break;
    }
    default: break;
  }
  return jv;
}

// ---------------------------------------------------------------------------
// JNI return → JSI value conversion
// ---------------------------------------------------------------------------

// Cache for postToWorker JNI lookup
static jclass g_providerCls = nullptr;
static jmethodID g_postToWorker = nullptr;

static void ensureWorkerCache(JNIEnv *env) {
  if (!g_providerCls) {
    jclass local = env->FindClass("expo/modules/ferrum/FerrumModuleProvider");
    g_providerCls = (jclass)env->NewGlobalRef(local);
    env->DeleteLocalRef(local);
    g_postToWorker = env->GetStaticMethodID(g_providerCls,
        "postToWorker", "(Ljava/lang/Runnable;)V");
  }
}

static inline jsi::Value jniReturnToJSI(JNIEnv *env, jsi::Runtime &rt,
                                         int returnKind, jobject instance,
                                         jmethodID methodID, jvalue *jargs,
                                         int argCount, const char *argTypes) {
  switch (returnKind) {
    case 0: { // VoidKind — dispatch async to FerrumNativeWorker thread
      ensureWorkerCache(env);

      // Create global refs for instance and any object args (survive cross-thread)
      jobject instRef = env->NewGlobalRef(instance);
      jvalue asyncArgs[8] = {};
      for (int i = 0; i < argCount && i < 8; i++) {
        if (argTypes[i] == 'L' && jargs[i].l != nullptr) {
          asyncArgs[i].l = env->NewGlobalRef(jargs[i].l);
        } else {
          asyncArgs[i] = jargs[i];
        }
      }

      // Wrap in a Java Runnable via JNI
      struct VoidCallData {
        jobject instance;
        jmethodID methodID;
        jvalue args[8];
        int argCount;
        char argTypes[8];
      };
      auto *data = new VoidCallData{instRef, methodID, {}, argCount, {}};
      memcpy(data->args, asyncArgs, sizeof(asyncArgs));
      memcpy(data->argTypes, argTypes, 8);

      // Create a Java Runnable that calls our native dispatch
      // Use fbjni to create a lambda-backed Runnable
      auto runnable = jni::JNativeRunnable::newObjectCxxArgs([data]() {
        JNIEnv *bgEnv = jni::Environment::current();
        bgEnv->CallVoidMethodA(data->instance, data->methodID, data->args);
        if (bgEnv->ExceptionCheck()) bgEnv->ExceptionClear();
        // Clean up global refs
        bgEnv->DeleteGlobalRef(data->instance);
        for (int i = 0; i < data->argCount; i++) {
          if (data->argTypes[i] == 'L' && data->args[i].l != nullptr) {
            bgEnv->DeleteGlobalRef(data->args[i].l);
          }
        }
        delete data;
      });

      env->CallStaticVoidMethod(g_providerCls, g_postToWorker, runnable.get());
      return jsi::Value::undefined();
    }
    case 1: { // BooleanKind
      jboolean r = env->CallBooleanMethodA(instance, methodID, jargs);
      return jsi::Value(static_cast<bool>(r));
    }
    case 2: { // NumberKind — try double first
      jdouble r = env->CallDoubleMethodA(instance, methodID, jargs);
      return jsi::Value(r);
    }
    case 3: { // StringKind
      auto returnString = (jstring)env->CallObjectMethodA(instance, methodID, jargs);
      if (!returnString) return jsi::Value::null();
      const char *chars = env->GetStringUTFChars(returnString, nullptr);
      auto result = jsi::String::createFromUtf8(rt, chars);
      env->ReleaseStringUTFChars(returnString, chars);
      env->DeleteLocalRef(returnString);
      return jsi::Value(rt, result);
    }
    case 4: // ObjectKind — fallback for now
    case 5: // ArrayKind
    case 6: // PromiseKind
    default:
      return jsi::Value::undefined();
  }
}

// ---------------------------------------------------------------------------
// Pre-resolved call function — handles all arg/return combinations
// ---------------------------------------------------------------------------

static jsi::Value ferrum_jni_call(
    const FerrumJNIDispatchInfo *info,
    JNIEnv *env,
    jsi::Runtime &rt,
    const jsi::Value *args,
    size_t count) {

  // Stack-local jvalue array — no heap allocation
  jvalue jargs[8] = {};
  for (int i = 0; i < info->argCount && i < 8; i++) {
    jargs[i] = jsiToJValue(env, rt, args[i], info->argTypes[i]);
  }

  auto result = jniReturnToJSI(env, rt, info->returnKind,
                                info->instance, info->methodID, jargs,
                                info->argCount, info->argTypes);

  // Check for JNI exceptions
  if (env->ExceptionCheck()) {
    jthrowable exc = env->ExceptionOccurred();
    env->ExceptionClear();
    if (exc) {
      jclass cls = env->GetObjectClass(exc);
      jmethodID getMessage = env->GetMethodID(cls, "getMessage", "()Ljava/lang/String;");
      auto msg = (jstring)env->CallObjectMethod(exc, getMessage);
      if (msg) {
        const char *chars = env->GetStringUTFChars(msg, nullptr);
        __android_log_print(ANDROID_LOG_ERROR, "Ferrum", "JNI exception in FFI call: %s", chars);
        env->ReleaseStringUTFChars(msg, chars);
        env->DeleteLocalRef(msg);
      }
      env->DeleteLocalRef(cls);
      env->DeleteLocalRef(exc);
    }
  }

  // Clean up local refs for object args
  for (int i = 0; i < info->argCount; i++) {
    if (info->argTypes[i] == 'L' && jargs[i].l != nullptr) {
      env->DeleteLocalRef(jargs[i].l);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Parse JNI signature → arg type chars
// ---------------------------------------------------------------------------

static int parseArgTypes(const char *sig, char *outTypes, int maxArgs) {
  int count = 0;
  const char *p = sig;
  if (*p != '(') return 0;
  p++;

  while (*p && *p != ')' && count < maxArgs) {
    if (*p == 'D') { outTypes[count++] = 'D'; p++; }
    else if (*p == 'F') { outTypes[count++] = 'F'; p++; }
    else if (*p == 'I') { outTypes[count++] = 'I'; p++; }
    else if (*p == 'Z') { outTypes[count++] = 'Z'; p++; }
    else if (*p == 'L') {
      outTypes[count++] = 'L';
      while (*p && *p != ';') p++;
      if (*p == ';') p++;
    }
    else { p++; } // skip unknown
  }
  return count;
}

// ---------------------------------------------------------------------------
// Build dispatch info
// ---------------------------------------------------------------------------

FerrumJNIDispatchInfo *ferrum_jni_dispatch_build(
    JNIEnv *env,
    jobject instance,
    const char *methodName,
    const char *jniSignature,
    int returnKind,
    int jsArgCount) {

  // Parse arg types first to check if all are supported
  char argTypes[8] = {};
  int parsedCount = parseArgTypes(jniSignature, argTypes, 8);

  // Check for unsupported arg types — Callback, Promise, ReadableMap, ReadableArray
  // are 'L' (object) types that need special conversion we don't handle yet.
  // Only support: primitives (D, F, I, Z) and simple string args (L for String).
  // For now, skip methods with Callback/Promise args (returnKind == 6 is PromiseKind).
  if (returnKind == 6) return nullptr; // PromiseKind — needs resolve/reject wiring
  for (int i = 0; i < parsedCount; i++) {
    if (argTypes[i] == 'L') {
      // Check if the L-type is a Callback by looking at the signature
      const char *p = jniSignature + 1; // skip '('
      int argIdx = 0;
      while (*p && *p != ')' && argIdx <= i) {
        if (*p == 'L') {
          if (argIdx == i) {
            // Check if this is a known safe type (String)
            if (strncmp(p, "Ljava/lang/String;", 18) != 0 &&
                strncmp(p, "Ljava/lang/Double;", 18) != 0 &&
                strncmp(p, "Ljava/lang/Boolean;", 19) != 0 &&
                strncmp(p, "Ljava/lang/Integer;", 19) != 0 &&
                strncmp(p, "Ljava/lang/Float;", 17) != 0) {
              // Unsupported object type (Callback, ReadableMap, etc.)
              return nullptr;
            }
          }
          while (*p && *p != ';') p++;
          if (*p == ';') p++;
          argIdx++;
        } else {
          p++;
          argIdx++;
        }
      }
    }
  }

  jclass cls = env->GetObjectClass(instance);
  jmethodID methodID = env->GetMethodID(cls, methodName, jniSignature);
  env->DeleteLocalRef(cls);

  if (!methodID) {
    env->ExceptionClear();
    return nullptr;
  }

  auto *info = new FerrumJNIDispatchInfo();
  info->instance = env->NewGlobalRef(instance);
  info->methodID = methodID;
  info->callFn = ferrum_jni_call;
  info->returnKind = returnKind;
  info->argCount = jsArgCount;
  memcpy(info->argTypes, argTypes, sizeof(argTypes));

  return info;
}

void ferrum_jni_dispatch_free(FerrumJNIDispatchInfo *info) {
  if (info) {
    JNIEnv *env = jni::Environment::current();
    if (env && info->instance) env->DeleteGlobalRef(info->instance);
    delete info;
  }
}
