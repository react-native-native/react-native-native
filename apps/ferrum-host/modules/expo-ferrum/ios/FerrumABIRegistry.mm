/// Ferrum C ABI bridge registry implementation.

#include <hermes_abi/hermes_abi.h>
#import "FerrumABIRegistry.h"
#import <string>
#import <unordered_map>
#import <cstring>

namespace {

struct ModuleEntry {
  const FerrumABIBridgeEntry *entries;
};

// Module name → bridge table
static std::unordered_map<std::string, ModuleEntry> &getRegistry() {
  static std::unordered_map<std::string, ModuleEntry> registry;
  return registry;
}

} // namespace

extern "C" {

void ferrum_abi_register_module(
    const char *moduleName,
    const FerrumABIBridgeEntry *entries) {
  getRegistry()[moduleName] = {entries};
  NSLog(@"[Ferrum] Registered C ABI bridges for module: %s", moduleName);
}

const FerrumABIBridgeEntry *ferrum_abi_lookup_module(const char *moduleName) {
  auto &reg = getRegistry();
  auto it = reg.find(moduleName);
  if (it == reg.end()) {
    return nullptr;
  }
  return it->second.entries;
}

FerrumABIBridgeFn ferrum_abi_lookup_method(
    const char *moduleName,
    const char *methodName) {
  const FerrumABIBridgeEntry *entries = ferrum_abi_lookup_module(moduleName);
  if (!entries) {
    return nullptr;
  }
  for (const FerrumABIBridgeEntry *e = entries; e->methodName != nullptr; e++) {
    if (strcmp(e->methodName, methodName) == 0) {
      return e->fn;
    }
  }
  return nullptr;
}

} // extern "C"
