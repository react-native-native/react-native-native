#pragma once

// C ABI function types
typedef const char* (*RNASyncFn)(const char*);
typedef void (*RNAAsyncFn)(const char*, void (*)(const char*), void (*)(const char*, const char*));
typedef void (*FerrumRenderFn)(void*, float, float, void*, void*);

#ifdef __cplusplus
extern "C" {
#endif

void rna_register_sync(const char* moduleId, const char* fnName, RNASyncFn fn);
void rna_register_async(const char* moduleId, const char* fnName, RNAAsyncFn fn);
void ferrum_register_render(const char* componentId, FerrumRenderFn fn);
const char* ferrum_try_render(const char* componentId, void* view, float w, float h);

// JSI value access (C wrappers for Rust/Swift)
const char* ferrum_jsi_get_string(void* runtime, void* object, const char* prop_name);
double ferrum_jsi_get_number(void* runtime, void* object, const char* prop_name);
int ferrum_jsi_get_bool(void* runtime, void* object, const char* prop_name);
int ferrum_jsi_has_prop(void* runtime, void* object, const char* prop_name);
void ferrum_jsi_call_function(void* runtime, void* object, const char* prop_name);
void ferrum_jsi_call_function_with_string(void* runtime, void* object, const char* prop_name, const char* arg);

// Entry point for expo-ferrum backward compatibility
void ferrum_cpp_install(void *runtimePtr);

#ifdef __cplusplus
}
#endif
