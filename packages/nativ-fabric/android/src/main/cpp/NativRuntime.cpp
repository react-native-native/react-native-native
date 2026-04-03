// NativRuntime JNI bridge — Android equivalent of iOS NativRuntime.
// Maintains the render registry + sync function registry.
// User .so dylibs register via __attribute__((constructor)) at dlopen time.

#include <jni.h>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <android/log.h>

#define LOG_TAG "NativRuntime"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

// ─── Registry types (same C ABI as iOS) ────────────────────────────────

typedef const char* (*NativSyncFn)(const char* argsJson);
typedef void (*NativAsyncFn)(const char* argsJson, void (*resolve)(const char*), void (*reject)(const char*, const char*));
typedef void (*NativRenderFn)(void* view_handle, float width, float height,
                               void* runtime, void* props);

// ─── Registries ────────────────────────────────────────────────────────

static std::unordered_map<std::string, NativSyncFn>& getSyncRegistry() {
    static std::unordered_map<std::string, NativSyncFn> reg;
    return reg;
}

static std::unordered_map<std::string, NativAsyncFn>& getAsyncRegistry() {
    static std::unordered_map<std::string, NativAsyncFn> reg;
    return reg;
}

static std::unordered_map<std::string, NativRenderFn>& getRenderRegistry() {
    static std::unordered_map<std::string, NativRenderFn> reg;
    return reg;
}

// ─── Props snapshot (passed to render functions) ───────────────────────

struct PropsSnapshot {
    std::unordered_map<std::string, std::string> strings;
    std::unordered_map<std::string, double> numbers;
    std::unordered_map<std::string, bool> bools;
    std::unordered_set<std::string> callbacks;
};

// Current render's props (set during tryRender, read by nativ_jsi_get_*)
static thread_local PropsSnapshot* g_currentProps = nullptr;
static thread_local std::string g_currentComponent;

// Current render's JNI state (for view manipulation from user dylibs)
static thread_local JNIEnv* g_currentEnv = nullptr;
static thread_local jobject g_currentView = nullptr;

// ─── C ABI exports (called by user .so dylibs via constructor) ─────────

extern "C" {

void nativ_register_sync(const char* moduleId, const char* fnName, NativSyncFn fn) {
    auto key = std::string(moduleId) + "::" + fnName;
    getSyncRegistry()[key] = fn;
    LOGI("registered sync: %s", key.c_str());
}

void nativ_register_async(const char* moduleId, const char* fnName, NativAsyncFn fn) {
    auto key = std::string(moduleId) + "::" + fnName;
    getAsyncRegistry()[key] = fn;
    LOGI("registered async: %s", key.c_str());
}

void nativ_register_render(const char* componentId, NativRenderFn fn) {
    getRenderRegistry()[std::string(componentId)] = fn;
    LOGI("registered render: %s", componentId);
}

// ─── Props access (called by Rust/C++ render functions) ────────────────

const char* nativ_jsi_get_string(void* runtime, void* object, const char* prop_name) {
    if (!g_currentProps) return "";
    auto it = g_currentProps->strings.find(std::string(prop_name));
    if (it != g_currentProps->strings.end()) {
        static thread_local std::string buf;
        buf = it->second;
        return buf.c_str();
    }
    return "";
}

double nativ_jsi_get_number(void* runtime, void* object, const char* prop_name) {
    if (!g_currentProps) return 0.0;
    auto it = g_currentProps->numbers.find(std::string(prop_name));
    if (it != g_currentProps->numbers.end()) return it->second;
    return 0.0;
}

int nativ_jsi_get_bool(void* runtime, void* object, const char* prop_name) {
    if (!g_currentProps) return 0;
    auto it = g_currentProps->bools.find(std::string(prop_name));
    if (it != g_currentProps->bools.end()) return it->second ? 1 : 0;
    return 0;
}

int nativ_jsi_has_prop(void* runtime, void* object, const char* prop_name) {
    if (!g_currentProps) return 0;
    std::string name(prop_name);
    return (g_currentProps->strings.count(name) ||
            g_currentProps->numbers.count(name) ||
            g_currentProps->bools.count(name)) ? 1 : 0;
}

void nativ_jsi_call_function(void* runtime, void* object, const char* prop_name) {
    // TODO: callbacks via JNI → JS bridge
    LOGI("call_function('%s') — not yet implemented on Android", prop_name);
}

void nativ_jsi_call_function_with_string(void* runtime, void* object,
                                          const char* prop_name, const char* arg) {
    LOGI("call_function_with_string('%s') — not yet implemented on Android", prop_name);
}

// Keep view register stubs for ABI compat with iOS dylibs
void nativ_register_view(const char*, void*) {}
void nativ_unregister_view(const char*) {}

// Direct C dispatch — called from NativBindingsInstaller.cpp
const char* nativ_call_sync(const char* moduleId, const char* fnName, const char* argsJson) {
    auto key = std::string(moduleId) + "::" + fnName;
    auto &reg = getSyncRegistry();
    auto it = reg.find(key);
    if (it == reg.end()) return nullptr;
    return it->second(argsJson);
}

// Async dispatch — returns the function pointer (BindingsInstaller handles Promise + threading)
NativAsyncFn nativ_get_async_fn(const char* moduleId, const char* fnName) {
    auto key = std::string(moduleId) + "::" + fnName;
    auto &reg = getAsyncRegistry();
    auto it = reg.find(key);
    if (it == reg.end()) return nullptr;
    return it->second;
}

// ─── Android view manipulation (called by Rust/C++ render functions) ──

void nativ_view_set_background_color(void* view, double r, double g, double b, double a) {
    if (!g_currentEnv) return;
    JNIEnv* env = g_currentEnv;
    jobject targetView = view ? (jobject)view : g_currentView;
    if (!targetView) return;

    int color = ((int)(a * 255) << 24) | ((int)(r * 255) << 16) |
                ((int)(g * 255) << 8) | (int)(b * 255);

    jclass viewClass = env->FindClass("android/view/View");
    jmethodID setBg = env->GetMethodID(viewClass, "setBackgroundColor", "(I)V");
    env->CallVoidMethod(targetView, setBg, color);
    env->DeleteLocalRef(viewClass);
}

void nativ_view_add_label(void* parent, const char* text,
                           double r, double g, double b,
                           double width, double height) {
    if (!g_currentEnv) return;
    JNIEnv* env = g_currentEnv;
    jobject parentView = parent ? (jobject)parent : g_currentView;
    if (!parentView) return;

    // Get context from parent view
    jclass viewClass = env->FindClass("android/view/View");
    jmethodID getContext = env->GetMethodID(viewClass, "getContext",
                                            "()Landroid/content/Context;");
    jobject context = env->CallObjectMethod(parentView, getContext);

    // Create TextView
    jclass tvClass = env->FindClass("android/widget/TextView");
    jmethodID tvInit = env->GetMethodID(tvClass, "<init>",
                                        "(Landroid/content/Context;)V");
    jobject tv = env->NewObject(tvClass, tvInit, context);

    // setText
    jstring jText = env->NewStringUTF(text);
    jmethodID setText = env->GetMethodID(tvClass, "setText",
                                         "(Ljava/lang/CharSequence;)V");
    env->CallVoidMethod(tv, setText, jText);

    // setTextColor
    int color = (0xFF << 24) | ((int)(r * 255) << 16) |
                ((int)(g * 255) << 8) | (int)(b * 255);
    jmethodID setColor = env->GetMethodID(tvClass, "setTextColor", "(I)V");
    env->CallVoidMethod(tv, setColor, color);

    // setGravity(Gravity.CENTER = 17)
    jmethodID setGravity = env->GetMethodID(tvClass, "setGravity", "(I)V");
    env->CallVoidMethod(tv, setGravity, 17);

    // setTextSize
    jmethodID setTextSize = env->GetMethodID(tvClass, "setTextSize", "(F)V");
    env->CallVoidMethod(tv, setTextSize, 18.0f);

    // LayoutParams = MATCH_PARENT, MATCH_PARENT
    jclass lpClass = env->FindClass("android/widget/FrameLayout$LayoutParams");
    jmethodID lpInit = env->GetMethodID(lpClass, "<init>", "(II)V");
    jobject lp = env->NewObject(lpClass, lpInit, -1, -1);

    // addView(tv, lp)
    jclass vgClass = env->FindClass("android/view/ViewGroup");
    jmethodID addView = env->GetMethodID(vgClass, "addView",
        "(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V");
    env->CallVoidMethod(parentView, addView, tv, lp);

    if (env->ExceptionCheck()) {
        LOGE("add_label: exception after addView");
        env->ExceptionDescribe();
        env->ExceptionClear();
    } else {
        LOGI("add_label: added '%s' to parent", text);
    }

    env->DeleteLocalRef(lp);
    env->DeleteLocalRef(tv);
    env->DeleteLocalRef(jText);
    env->DeleteLocalRef(context);
    env->DeleteLocalRef(lpClass);
    env->DeleteLocalRef(vgClass);
    env->DeleteLocalRef(tvClass);
    env->DeleteLocalRef(viewClass);
}

void* nativ_view_add_subview(void* parent, double x, double y,
                              double w, double h,
                              double r, double g, double b, double a) {
    if (!g_currentEnv) return nullptr;
    JNIEnv* env = g_currentEnv;
    jobject parentView = parent ? (jobject)parent : g_currentView;
    if (!parentView) return nullptr;

    // Get context
    jclass viewClass = env->FindClass("android/view/View");
    jmethodID getContext = env->GetMethodID(viewClass, "getContext",
                                            "()Landroid/content/Context;");
    jobject context = env->CallObjectMethod(parentView, getContext);

    // Create child View
    jobject child = env->NewObject(viewClass,
        env->GetMethodID(viewClass, "<init>", "(Landroid/content/Context;)V"),
        context);

    // setBackgroundColor
    int color = ((int)(a * 255) << 24) | ((int)(r * 255) << 16) |
                ((int)(g * 255) << 8) | (int)(b * 255);
    jmethodID setBg = env->GetMethodID(viewClass, "setBackgroundColor", "(I)V");
    env->CallVoidMethod(child, setBg, color);

    // Convert dp coords to pixels
    jclass dpClass = env->FindClass("android/util/TypedValue");
    jmethodID applyDim = env->GetStaticMethodID(dpClass, "applyDimension",
        "(IFLandroid/util/DisplayMetrics;)F");
    jclass contextClass = env->FindClass("android/content/Context");
    jmethodID getResources = env->GetMethodID(contextClass, "getResources",
        "()Landroid/content/res/Resources;");
    jobject resources = env->CallObjectMethod(context, getResources);
    jclass resClass = env->GetObjectClass(resources);
    jmethodID getMetrics = env->GetMethodID(resClass, "getDisplayMetrics",
        "()Landroid/util/DisplayMetrics;");
    jobject metrics = env->CallObjectMethod(resources, getMetrics);

    // TypedValue.COMPLEX_UNIT_DIP = 1
    float px = (float)x; // points ≈ dp on Android
    float py = (float)y;
    float pw = (float)w;
    float ph = (float)h;
    // Scale from points to pixels using density
    jclass metricsClass = env->GetObjectClass(metrics);
    jfieldID densityField = env->GetFieldID(metricsClass, "density", "F");
    float density = env->GetFloatField(metrics, densityField);
    int pxX = (int)(px * density);
    int pxY = (int)(py * density);
    int pxW = (int)(pw * density);
    int pxH = (int)(ph * density);

    // LayoutParams with position
    jclass lpClass = env->FindClass("android/widget/FrameLayout$LayoutParams");
    jmethodID lpInit = env->GetMethodID(lpClass, "<init>", "(II)V");
    jobject lp = env->NewObject(lpClass, lpInit, pxW, pxH);

    // Set margins for position (FrameLayout uses margins for positioning)
    jfieldID leftMargin = env->GetFieldID(lpClass, "leftMargin", "I");
    jfieldID topMargin = env->GetFieldID(lpClass, "topMargin", "I");
    env->SetIntField(lp, leftMargin, pxX);
    env->SetIntField(lp, topMargin, pxY);

    // addView
    jclass vgClass = env->FindClass("android/view/ViewGroup");
    jmethodID addView = env->GetMethodID(vgClass, "addView",
        "(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V");
    env->CallVoidMethod(parentView, addView, child, lp);

    // Return as global ref (user may reference it later in same render)
    jobject globalChild = env->NewGlobalRef(child);

    // Clean up local refs
    env->DeleteLocalRef(lp);
    env->DeleteLocalRef(child);
    env->DeleteLocalRef(context);
    env->DeleteLocalRef(resources);
    env->DeleteLocalRef(metrics);
    env->DeleteLocalRef(lpClass);
    env->DeleteLocalRef(vgClass);
    env->DeleteLocalRef(viewClass);
    env->DeleteLocalRef(dpClass);
    env->DeleteLocalRef(contextClass);
    env->DeleteLocalRef(resClass);
    env->DeleteLocalRef(metricsClass);

    return globalChild;
}

} // extern "C"

// ─── JNI helpers ───────────────────────────────────────────────────────

static std::string jstringToString(JNIEnv* env, jstring jstr) {
    if (!jstr) return "";
    const char* chars = env->GetStringUTFChars(jstr, nullptr);
    std::string result(chars);
    env->ReleaseStringUTFChars(jstr, chars);
    return result;
}

// Convert a Java Map<String, String> to C++ map
static std::unordered_map<std::string, std::string> jmapToStringMap(JNIEnv* env, jobject jmap) {
    std::unordered_map<std::string, std::string> result;
    if (!jmap) return result;

    jclass mapClass = env->GetObjectClass(jmap);
    jmethodID entrySet = env->GetMethodID(mapClass, "entrySet", "()Ljava/util/Set;");
    jobject set = env->CallObjectMethod(jmap, entrySet);

    jclass setClass = env->GetObjectClass(set);
    jmethodID iterator = env->GetMethodID(setClass, "iterator", "()Ljava/util/Iterator;");
    jobject iter = env->CallObjectMethod(set, iterator);

    jclass iterClass = env->GetObjectClass(iter);
    jmethodID hasNext = env->GetMethodID(iterClass, "hasNext", "()Z");
    jmethodID next = env->GetMethodID(iterClass, "next", "()Ljava/lang/Object;");

    jclass entryClass = env->FindClass("java/util/Map$Entry");
    jmethodID getKey = env->GetMethodID(entryClass, "getKey", "()Ljava/lang/Object;");
    jmethodID getValue = env->GetMethodID(entryClass, "getValue", "()Ljava/lang/Object;");

    while (env->CallBooleanMethod(iter, hasNext)) {
        jobject entry = env->CallObjectMethod(iter, next);
        auto key = jstringToString(env, (jstring)env->CallObjectMethod(entry, getKey));
        auto val = jstringToString(env, (jstring)env->CallObjectMethod(entry, getValue));
        result[key] = val;
        env->DeleteLocalRef(entry);
    }
    return result;
}

// Convert a Java Map<String, Double> to C++ map
static std::unordered_map<std::string, double> jmapToDoubleMap(JNIEnv* env, jobject jmap) {
    std::unordered_map<std::string, double> result;
    if (!jmap) return result;

    jclass mapClass = env->GetObjectClass(jmap);
    jmethodID entrySet = env->GetMethodID(mapClass, "entrySet", "()Ljava/util/Set;");
    jobject set = env->CallObjectMethod(jmap, entrySet);

    jclass setClass = env->GetObjectClass(set);
    jmethodID iterator = env->GetMethodID(setClass, "iterator", "()Ljava/util/Iterator;");
    jobject iter = env->CallObjectMethod(set, iterator);

    jclass iterClass = env->GetObjectClass(iter);
    jmethodID hasNext = env->GetMethodID(iterClass, "hasNext", "()Z");
    jmethodID next = env->GetMethodID(iterClass, "next", "()Ljava/lang/Object;");

    jclass entryClass = env->FindClass("java/util/Map$Entry");
    jmethodID getKey = env->GetMethodID(entryClass, "getKey", "()Ljava/lang/Object;");
    jmethodID getValue = env->GetMethodID(entryClass, "getValue", "()Ljava/lang/Object;");

    jclass doubleClass = env->FindClass("java/lang/Double");
    jmethodID doubleValue = env->GetMethodID(doubleClass, "doubleValue", "()D");

    while (env->CallBooleanMethod(iter, hasNext)) {
        jobject entry = env->CallObjectMethod(iter, next);
        auto key = jstringToString(env, (jstring)env->CallObjectMethod(entry, getKey));
        jobject valObj = env->CallObjectMethod(entry, getValue);
        double val = env->CallDoubleMethod(valObj, doubleValue);
        result[key] = val;
        env->DeleteLocalRef(valObj);
        env->DeleteLocalRef(entry);
    }
    return result;
}

// Convert a Java Map<String, Boolean> to C++ map
static std::unordered_map<std::string, bool> jmapToBoolMap(JNIEnv* env, jobject jmap) {
    std::unordered_map<std::string, bool> result;
    if (!jmap) return result;

    jclass mapClass = env->GetObjectClass(jmap);
    jmethodID entrySet = env->GetMethodID(mapClass, "entrySet", "()Ljava/util/Set;");
    jobject set = env->CallObjectMethod(jmap, entrySet);

    jclass setClass = env->GetObjectClass(set);
    jmethodID iterator = env->GetMethodID(setClass, "iterator", "()Ljava/util/Iterator;");
    jobject iter = env->CallObjectMethod(set, iterator);

    jclass iterClass = env->GetObjectClass(iter);
    jmethodID hasNext = env->GetMethodID(iterClass, "hasNext", "()Z");
    jmethodID next = env->GetMethodID(iterClass, "next", "()Ljava/lang/Object;");

    jclass entryClass = env->FindClass("java/util/Map$Entry");
    jmethodID getKey = env->GetMethodID(entryClass, "getKey", "()Ljava/lang/Object;");
    jmethodID getValue = env->GetMethodID(entryClass, "getValue", "()Ljava/lang/Object;");

    jclass boolClass = env->FindClass("java/lang/Boolean");
    jmethodID boolValue = env->GetMethodID(boolClass, "booleanValue", "()Z");

    while (env->CallBooleanMethod(iter, hasNext)) {
        jobject entry = env->CallObjectMethod(iter, next);
        auto key = jstringToString(env, (jstring)env->CallObjectMethod(entry, getKey));
        jobject valObj = env->CallObjectMethod(entry, getValue);
        bool val = env->CallBooleanMethod(valObj, boolValue);
        result[key] = val;
        env->DeleteLocalRef(valObj);
        env->DeleteLocalRef(entry);
    }
    return result;
}

// ─── JNI exports ───────────────────────────────────────────────────────

extern "C" {

JNIEXPORT void JNICALL
Java_com_nativfabric_NativRuntime_nativeInit(JNIEnv* env, jobject thiz) {
    LOGI("NativRuntime initialized");
}

JNIEXPORT void JNICALL
Java_com_nativfabric_NativRuntime_nativeTryRender(
    JNIEnv* env, jobject thiz,
    jstring jComponentId, jobject jView, jfloat width, jfloat height,
    jobject jStrings, jobject jNumbers, jobject jBools
) {
    auto componentId = jstringToString(env, jComponentId);
    LOGI("nativeTryRender: %s (%.0fx%.0f), registry size=%zu", componentId.c_str(), width, height, getRenderRegistry().size());
    auto &reg = getRenderRegistry();
    auto it = reg.find(componentId);
    if (it == reg.end()) {
        LOGE("nativeTryRender: render function not found for %s", componentId.c_str());
        return;
    }
    LOGI("nativeTryRender: calling render function for %s", componentId.c_str());

    // Build props snapshot from Java maps
    PropsSnapshot props;
    props.strings = jmapToStringMap(env, jStrings);
    props.numbers = jmapToDoubleMap(env, jNumbers);
    props.bools = jmapToBoolMap(env, jBools);

    // Set thread-local state for the render call
    g_currentProps = &props;
    g_currentComponent = componentId;
    g_currentEnv = env;
    g_currentView = jView;

    // Pass the view jobject as void* — render functions use nativ_view_* APIs
    // which access g_currentEnv + g_currentView internally.
    // Pass non-null sentinels for runtime/props — Android's nativ_jsi_get_*
    // functions read from g_currentProps, but Props::new() requires both non-null.
    static int runtimeSentinel = 1;
    it->second(reinterpret_cast<void*>(jView), width, height,
               reinterpret_cast<void*>(&runtimeSentinel),
               reinterpret_cast<void*>(&props));

    g_currentProps = nullptr;
    g_currentComponent.clear();
    g_currentEnv = nullptr;
    g_currentView = nullptr;
}

JNIEXPORT jstring JNICALL
Java_com_nativfabric_NativRuntime_nativeCallSync(
    JNIEnv* env, jobject thiz,
    jstring jModuleId, jstring jFnName, jstring jArgsJson
) {
    auto moduleId = jstringToString(env, jModuleId);
    auto fnName = jstringToString(env, jFnName);
    auto argsJson = jstringToString(env, jArgsJson);

    auto key = moduleId + "::" + fnName;
    auto &reg = getSyncRegistry();
    auto it = reg.find(key);
    if (it == reg.end()) {
        LOGE("Unknown function: %s", key.c_str());
        return nullptr;
    }

    const char* result = it->second(argsJson.c_str());
    if (!result) return nullptr;
    return env->NewStringUTF(result);
}

} // extern "C"
