/**
 * Extracts #[function(...)] annotated functions from Rust source files.
 * Similar to cpp-ast-extractor.js but for Rust syntax.
 *
 * Supports:
 *   #[function]           → sync
 *   #[function(sync)]     → sync
 *   #[function(async)]    → async (returns Promise in JS)
 *
 * Also detects if the file is a component (has `pub fn render(`)
 */

const fs = require('fs');

// Map Rust types to TypeScript
const RUST_TO_TS = {
  'i8': 'number', 'i16': 'number', 'i32': 'number', 'i64': 'number',
  'u8': 'number', 'u16': 'number', 'u32': 'number', 'u64': 'number',
  'f32': 'number', 'f64': 'number',
  'usize': 'number', 'isize': 'number',
  'bool': 'boolean',
  'String': 'string', '&str': 'string',
  '()': 'void',
};

function rustTypeToTS(rustType) {
  const t = rustType.trim();
  if (RUST_TO_TS[t]) return RUST_TO_TS[t];

  // Result<T, E> → T (we throw on Err)
  const resultMatch = t.match(/^Result\s*<\s*(.+?)\s*,/);
  if (resultMatch) return rustTypeToTS(resultMatch[1]);

  // Vec<T> → T[]
  const vecMatch = t.match(/^Vec\s*<\s*(.+?)\s*>$/);
  if (vecMatch) return rustTypeToTS(vecMatch[1]) + '[]';

  // Option<T> → T | null
  const optMatch = t.match(/^Option\s*<\s*(.+?)\s*>$/);
  if (optMatch) return rustTypeToTS(optMatch[1]) + ' | null';

  return 'unknown';
}

/**
 * Parse a .rs file and return exported functions + whether it's a component.
 */
function extractRustExports(filepath) {
  let src;
  try {
    src = fs.readFileSync(filepath, 'utf8');
  } catch {
    return { functions: [], isComponent: false };
  }

  const isComponent = /#\[component\]/.test(src);

  // Extract component props from struct fields
  const componentProps = [];
  if (isComponent) {
    // Match: pub struct Name { field: Type, ... }
    const structMatch = src.match(/#\[component\]\s*pub\s+struct\s+(\w+)\s*\{([^}]*)\}/s);
    if (structMatch) {
      const fieldsStr = structMatch[2];
      for (const line of fieldsStr.split('\n')) {
        const fieldMatch = line.trim().match(/^(\w+)\s*:\s*(.+?)\s*,?\s*$/);
        if (fieldMatch) {
          const [, name, rustType] = fieldMatch;
          const jsName = snakeToCamel(name);
          const tsType = rustType.trim() === 'Callback'
            ? '(() => void)'
            : rustTypeToTS(rustType.trim());
          componentProps.push({ name, jsName, rustType: rustType.trim(), tsType });
        }
      }
    }
  }

  const functions = [];

  // Match: #[function] or #[function(sync)] or #[function(async)] followed by pub fn
  const pattern = /#\[function(?:\s*\(([^)]*)\))?\]\s*pub\s+fn\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*([^\{]+))?\s*\{/g;

  let match;
  while ((match = pattern.exec(src)) !== null) {
    const [, attrs, name, argsStr, retType] = match;
    const isAsync = (attrs || '').includes('async');

    const args = argsStr
      .split(',')
      .map(a => a.trim())
      .filter(a => a && !a.startsWith('&self'))
      .map(arg => {
        const parts = arg.match(/^(\w+)\s*:\s*(.+)$/);
        if (parts) {
          return { name: parts[1], type: parts[2].trim(), tsType: rustTypeToTS(parts[2].trim()) };
        }
        return { name: '_', type: arg, tsType: 'unknown' };
      });

    functions.push({
      name,
      async: isAsync,
      args,
      ret: retType ? retType.trim() : '()',
      retTS: retType ? rustTypeToTS(retType.trim()) : 'void',
    });
  }

  return { functions, isComponent, componentProps };
}

/** Convert snake_case to camelCase (matches the Rust proc macro's to_camel_case) */
function snakeToCamel(s) {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

module.exports = { extractRustExports, rustTypeToTS, snakeToCamel };
