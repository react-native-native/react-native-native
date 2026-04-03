/**
 * Generates C ABI bridge wrappers for NATIV_EXPORT-annotated functions.
 * Each exported function gets a C-linkage wrapper that the JS runtime calls.
 */

function generateCppBridge(exports, moduleId) {
  const safeModuleId = moduleId.replace(/[^a-zA-Z0-9_]/g, '_');
  const lines = [
    `// Auto-generated bridge for ${moduleId}`,
    '#include "Nativ.h"',
    '#include <string>',
    '',
    'extern "C" {',
  ];

  for (const fn of exports) {
    if (fn.async) {
      lines.push(`
void nativ_${safeModuleId}_${fn.name}(
    const char* argsJson,
    void (*resolve)(const char*),
    void (*reject)(const char*, const char*)
) {
    try {
        auto result = ${fn.name}(/* TODO: parse args from argsJson */);
        auto json = nativ::toJson(result);
        resolve(json.c_str());
    } catch (const std::exception& e) {
        reject("NATIV_ERROR", e.what());
    } catch (...) {
        reject("NATIV_ERROR", "Unknown error");
    }
}`);
    } else {
      lines.push(`
const char* nativ_${safeModuleId}_${fn.name}(const char* argsJson) {
    auto result = ${fn.name}(/* TODO: parse args from argsJson */);
    static thread_local std::string buf;
    buf = nativ::toJson(result);
    return buf.c_str();
}`);
    }
  }

  lines.push('');
  lines.push('} // extern "C"');
  return lines.join('\n');
}

module.exports = { generateCppBridge };
