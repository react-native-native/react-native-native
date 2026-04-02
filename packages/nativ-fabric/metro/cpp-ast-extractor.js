/**
 * Extracts RNA_EXPORT annotated functions from C++/ObjC++ files.
 *
 * Uses regex to find RNA_EXPORT annotations and parse function signatures.
 * This is simpler and more portable than relying on clang's JSON AST dump
 * (which doesn't include annotation values in all versions).
 */

const fs = require('fs');

/**
 * Parse a C++/ObjC++ file and return all RNA_EXPORT-annotated function declarations.
 *
 * @param {string} filename — absolute path to .cpp/.mm file
 * @param {string[]} _includePaths — unused (kept for API compat)
 * @returns {{ name: string, async: boolean, args: { name: string, type: string }[], ret: string }[]}
 */
function isCppComponent(filename) {
  try {
    const src = fs.readFileSync(filename, 'utf8');
    return src.includes('ferrum::component') || src.includes('FERRUM_COMPONENT') || src.includes('RNA_COMPONENT');
  } catch {
    return false;
  }
}

function extractCppExports(filename, _includePaths) {
  let src;
  try {
    src = fs.readFileSync(filename, 'utf8');
  } catch {
    return [];
  }

  const exports = [];

  // Match: RNA_EXPORT(sync|async)\n<return_type> <name>(<args>)
  // The regex handles multi-line signatures and common C++ types.
  const pattern = /RNA_EXPORT\s*\(\s*(sync|async)\s*\)\s*\n\s*(.+?)\s+(\w+)\s*\(([^)]*)\)/g;

  let match;
  while ((match = pattern.exec(src)) !== null) {
    const [, mode, retType, name, argsStr] = match;

    const args = argsStr
      .split(',')
      .map(a => a.trim())
      .filter(Boolean)
      .map(arg => {
        // Parse "const std::string& name" → { type: "const std::string&", name: "name" }
        const parts = arg.match(/^(.+?)\s+(\w+)$/);
        if (parts) {
          return { type: parts[1].trim(), name: parts[2] };
        }
        return { type: arg, name: '_unnamed' };
      });

    exports.push({
      name,
      async: mode === 'async',
      args,
      ret: retType.trim(),
    });
  }

  return exports;
}

/**
 * Extract component props from a C++ props struct.
 * Parses: struct XxxProps { std::string title = "default"; double opacity = 1.0; ... };
 */
function extractCppComponentProps(filename) {
  let src;
  try { src = fs.readFileSync(filename, 'utf8'); } catch { return []; }

  // Find RNA_COMPONENT(name, PropsType)
  const compMatch = src.match(/RNA_COMPONENT\s*\(\s*(\w+)\s*,\s*(\w+)\s*\)/);
  if (!compMatch) return [];

  const propsTypeName = compMatch[2];

  // Find the struct definition
  const structRegex = new RegExp(`struct\\s+${propsTypeName}\\s*\\{([^}]*)\\}`, 's');
  const structMatch = src.match(structRegex);
  if (!structMatch) return [];

  const props = [];
  const CPP_TO_TS = {
    'std::string': 'string',
    'double': 'number',
    'float': 'number',
    'int': 'number',
    'int32_t': 'number',
    'bool': 'boolean',
    'std::function<void()>': '(() => void)',
    'std::function<void(std::string)>': '((arg: string) => void)',
  };

  for (const line of structMatch[1].split('\n')) {
    const trimmed = line.trim().replace(/;$/, '').trim();
    if (!trimmed || trimmed.startsWith('//')) continue;

    // Match: type name = default  or  type name
    const fieldMatch = trimmed.match(/^(.+?)\s+(\w+)(?:\s*=\s*(.+))?$/);
    if (!fieldMatch) continue;

    const [, cppType, name, defaultVal] = fieldMatch;
    const cleanType = cppType.trim();

    // snake_case → camelCase
    const jsName = name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

    const tsType = CPP_TO_TS[cleanType] || 'unknown';

    props.push({ name, jsName, cppType: cleanType, tsType, defaultVal: defaultVal?.trim() });
  }

  return props;
}

module.exports = { extractCppExports, isCppComponent, extractCppComponentProps };
