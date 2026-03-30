/// FerrumJNIDispatch — pre-resolved JNI dispatch for Android TurboModules.
///
/// Registration: parse method info from Kotlin → resolve jmethodID + callFn.
/// Call time: one indirect call → inline JSI→jvalue conversion → CallXxxMethodA.

#pragma once

#include <jni.h>
#include <jsi/jsi.h>

struct FerrumJNIDispatchInfo;

/// Pre-resolved call function — one per method, determined at registration time.
typedef facebook::jsi::Value (*FerrumJNICallFn)(
    const FerrumJNIDispatchInfo *info,
    JNIEnv *env,
    facebook::jsi::Runtime &rt,
    const facebook::jsi::Value *args,
    size_t count);

/// Dispatch info — resolved once per method at module discovery time.
struct FerrumJNIDispatchInfo {
  jobject instance;       // global ref to the Java module
  jmethodID methodID;     // cached method ID
  FerrumJNICallFn callFn; // pre-resolved call function
  int returnKind;         // 0=void,1=bool,2=number,3=string,4=object,5=array,6=promise
  int argCount;
  char argTypes[8];       // JNI type chars: D,F,I,Z,L (object), P (promise)
};

/// Build dispatch info. Returns nullptr if unsupported.
FerrumJNIDispatchInfo *ferrum_jni_dispatch_build(
    JNIEnv *env,
    jobject instance,
    const char *methodName,
    const char *jniSignature,
    int returnKind,
    int jsArgCount);

/// Free dispatch info.
void ferrum_jni_dispatch_free(FerrumJNIDispatchInfo *info);
