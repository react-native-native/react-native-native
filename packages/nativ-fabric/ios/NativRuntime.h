#pragma once

// C ABI function types
typedef const char* (*NativSyncFn)(const char*);
typedef void (*NativAsyncFn)(const char*, void (*)(const char*), void (*)(const char*, const char*));
typedef void (*NativRenderFn)(void*, float, float, void*, void*);

#ifdef __cplusplus
extern "C" {
#endif

void nativ_register_sync(const char* moduleId, const char* fnName, NativSyncFn fn);
void nativ_register_async(const char* moduleId, const char* fnName, NativAsyncFn fn);
void nativ_register_render(const char* componentId, NativRenderFn fn);
const char* nativ_try_render(const char* componentId, void* view, float w, float h);

// JSI value access (C wrappers for Rust/Swift)
const char* nativ_jsi_get_string(void* runtime, void* object, const char* prop_name);
double nativ_jsi_get_number(void* runtime, void* object, const char* prop_name);
int nativ_jsi_get_bool(void* runtime, void* object, const char* prop_name);
int nativ_jsi_has_prop(void* runtime, void* object, const char* prop_name);
void nativ_jsi_call_function(void* runtime, void* object, const char* prop_name);
void nativ_jsi_call_function_with_string(void* runtime, void* object, const char* prop_name, const char* arg);

// Type checking
int nativ_jsi_is_array(void* runtime, void* object, const char* prop_name);
int nativ_jsi_get_array_length(void* runtime, void* object, const char* prop_name);
int nativ_jsi_is_object(void* runtime, void* object, const char* prop_name);
int nativ_jsi_is_null(void* runtime, void* object, const char* prop_name);

// Entry point for expo-ferrum backward compatibility
void nativ_cpp_install(void *runtimePtr);

#ifdef __cplusplus
}
#endif
