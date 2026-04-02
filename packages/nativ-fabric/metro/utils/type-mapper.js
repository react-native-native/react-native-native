/**
 * Maps C++ types to TypeScript types for .d.ts generation.
 */

const CPP_TO_TS = {
  // Primitives
  'int': 'number',
  'int32_t': 'number',
  'int64_t': 'number',
  'uint32_t': 'number',
  'uint64_t': 'number',
  'size_t': 'number',
  'float': 'number',
  'double': 'number',
  'bool': 'boolean',
  'void': 'void',

  // Strings
  'std::string': 'string',
  'const std::string &': 'string',
  'const std::string&': 'string',
  'const char *': 'string',
  'const char*': 'string',

  // Buffers
  'std::vector<uint8_t>': 'Uint8Array',
  'std::vector<float>': 'Float32Array',

  // Collections
  'std::vector<std::string>': 'string[]',
  'std::vector<int>': 'number[]',
  'std::vector<double>': 'number[]',

  // Optional
  'std::optional<std::string>': 'string | null',
  'std::optional<int>': 'number | null',
  'std::optional<double>': 'number | null',
};

function cppTypeToTS(cppType, customTypes = {}) {
  const trimmed = cppType.trim()
    .replace(/\s+/g, ' ')             // normalize whitespace
    .replace(/\s*&\s*$/, '')          // strip trailing reference
    .replace(/^const\s+/, 'const ')   // normalize const prefix
    .trim();

  // Check custom NATIV_TYPE mappings first
  if (customTypes[trimmed]) return customTypes[trimmed];

  // Check built-in mapping (try with and without const/ref)
  if (CPP_TO_TS[trimmed]) return CPP_TO_TS[trimmed];

  // Try stripping const and reference
  const stripped = trimmed
    .replace(/^const\s+/, '')
    .replace(/\s*[&*]\s*$/, '')
    .trim();
  if (CPP_TO_TS[stripped]) return CPP_TO_TS[stripped];

  return 'unknown';
}

module.exports = { cppTypeToTS, CPP_TO_TS };
