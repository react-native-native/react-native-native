// RNAnywhere.h — Runtime header for react-native-anywhere C++/ObjC++ files.
// Include this in any .cpp or .mm file that exports functions or components to JS.

#pragma once

#include <string>
#include <vector>
#include <cstdint>
#include <stdexcept>
#include <optional>
#include <functional>

// ─── Function export annotation ───────────────────────────────────────
// RNA_EXPORT(sync)
// int add(int a, int b) { return a + b; }

#define RNA_EXPORT(mode) __attribute__((annotate("rna_export:" #mode)))

// ─── Component system ─────────────────────────────────────────────────
// Define a props struct, then use RNA_COMPONENT to register:
//
// struct MyProps {
//   std::string title = "Hello";
//   double opacity = 1.0;
//   std::function<void()> onPress;
// };
//
// RNA_COMPONENT(MyComponent, MyProps)
// void mount(void* view, float w, float h, MyProps props) {
//   UIView* v = (__bridge UIView*)view;
//   // ... use props.title, props.opacity, props.onPress()
// }

// JSI C API — defined in FerrumCppRuntime, resolved at dlopen
extern "C" {
  typedef void (*FerrumRenderFn)(void*, float, float, void*, void*);
  void ferrum_register_render(const char*, FerrumRenderFn);

  // Scalar props
  const char* ferrum_jsi_get_string(void* rt, void* obj, const char* name);
  double ferrum_jsi_get_number(void* rt, void* obj, const char* name);
  int ferrum_jsi_get_bool(void* rt, void* obj, const char* name);
  int ferrum_jsi_has_prop(void* rt, void* obj, const char* name);

  // Callbacks
  void ferrum_jsi_call_function(void* rt, void* obj, const char* name);
  void ferrum_jsi_call_function_with_string(void* rt, void* obj, const char* name, const char* arg);

  // Type checking
  int ferrum_jsi_is_array(void* rt, void* obj, const char* name);
  int ferrum_jsi_get_array_length(void* rt, void* obj, const char* name);
  int ferrum_jsi_is_object(void* rt, void* obj, const char* name);
  int ferrum_jsi_is_null(void* rt, void* obj, const char* name);
}

// Helper: extract a std::string prop
inline std::string _rna_get_string(void* rt, void* obj, const char* name, const std::string& def = "") {
  if (!rt || !obj) return def;
  const char* s = ferrum_jsi_get_string(rt, obj, name);
  return (s && s[0]) ? std::string(s) : def;
}

// Helper: extract a double prop
inline double _rna_get_number(void* rt, void* obj, const char* name, double def = 0.0) {
  if (!rt || !obj || !ferrum_jsi_has_prop(rt, obj, name)) return def;
  return ferrum_jsi_get_number(rt, obj, name);
}

// Helper: extract a bool prop
inline bool _rna_get_bool(void* rt, void* obj, const char* name, bool def = false) {
  if (!rt || !obj || !ferrum_jsi_has_prop(rt, obj, name)) return def;
  return ferrum_jsi_get_bool(rt, obj, name) != 0;
}

// Helper: extract a callback prop
inline std::function<void()> _rna_get_callback(void* rt, void* obj, const char* name) {
  if (!rt || !obj || !ferrum_jsi_has_prop(rt, obj, name)) return nullptr;
  // Capture by value — safe only during mount()
  return [rt, obj, n = std::string(name)]() {
    ferrum_jsi_call_function(rt, obj, n.c_str());
  };
}

// ferrum::component marker (parsed by Metro transformer)
// RNA_COMPONENT(Name, PropsStruct) must be followed by:
//   void mount(void* view, float w, float h, PropsStruct props) { ... }
#define RNA_COMPONENT(name, props_type)                                        \
  /* Forward declare mount */                                                  \
  static void mount(void* view, float w, float h, props_type props);           \
                                                                               \
  /* Render entry point — unique per component for static linking */           \
  extern "C" void ferrum_##name##_render(void* view, float w, float h,        \
                                         void* jsi_runtime, void* jsi_props); \
                                                                               \
  /* Registration */                                                           \
  __attribute__((constructor, used))                                           \
  static void _rna_register_##name() {                                         \
    ferrum_register_render("ferrum." #name, ferrum_##name##_render);            \
  }

// ─── JSON helpers (for RNA_EXPORT functions) ──────────────────────────

namespace rna {

inline std::string toJson(int v)         { return std::to_string(v); }
inline std::string toJson(int64_t v)     { return std::to_string(v); }
inline std::string toJson(uint32_t v)    { return std::to_string(v); }
inline std::string toJson(float v)       { return std::to_string(v); }
inline std::string toJson(double v)      { return std::to_string(v); }
inline std::string toJson(bool v)        { return v ? "true" : "false"; }
inline std::string toJson(const std::string& v) {
  std::string out = "\"";
  for (char c : v) {
    switch (c) {
      case '"':  out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n";  break;
      default:   out += c;      break;
    }
  }
  out += '"';
  return out;
}
inline std::string toJson(const char* v) { return v ? toJson(std::string(v)) : "null"; }

} // namespace rna
