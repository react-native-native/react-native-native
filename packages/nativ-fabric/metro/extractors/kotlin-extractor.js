/**
 * kotlin-extractor.js — extracts @nativ_export functions and @nativ_component
 * annotations from Kotlin source files.
 *
 * Mirrors rust-extractor.js / cpp-ast-extractor.js for the Kotlin path.
 */

const fs = require('fs');

// Kotlin type → TypeScript type mapping
const typeMap = {
  'Int': 'number',
  'Long': 'number',
  'Float': 'number',
  'Double': 'number',
  'Boolean': 'boolean',
  'String': 'string',
  'Unit': 'void',
};

function tsType(ktType) {
  return typeMap[ktType] || 'any';
}

/**
 * Extract exported functions and component info from a .kt file.
 *
 * Annotations (in comments, like Swift):
 *   // @nativ_export(sync)
 *   fun fibonacci(n: Int): Int { ... }
 *
 *   // @nativ_component
 *   @Composable
 *   fun Counter(count: Int, onPress: () -> Unit) { ... }
 */
function extractKotlinExports(filepath) {
  const src = fs.readFileSync(filepath, 'utf8');
  const lines = src.split('\n');
  const functions = [];
  let isComponent = false;
  const componentProps = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Check for // @nativ_export or // @nativ_component
    const exportMatch = line.match(/\/\/\s*@nativ_export\s*\(?\s*(sync|async)?\s*\)?/);
    const componentMatch = line.match(/\/\/\s*@nativ_component/);

    if (exportMatch) {
      const isAsync = exportMatch[1] === 'async';
      // Find the next `fun` declaration
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const fnLine = lines[j].trim();
        const fnMatch = fnLine.match(/fun\s+(\w+)\s*\(([^)]*)\)\s*(?::\s*(\S+))?/);
        if (fnMatch) {
          const name = fnMatch[1];
          const argsStr = fnMatch[2].trim();
          const ret = fnMatch[3] || 'Unit';

          const args = [];
          if (argsStr) {
            // Parse "name: Type, name2: Type2"
            for (const part of argsStr.split(',')) {
              const argMatch = part.trim().match(/(\w+)\s*:\s*(\S+)/);
              if (argMatch) {
                args.push({
                  name: argMatch[1],
                  type: argMatch[2],
                  tsType: tsType(argMatch[2]),
                });
              }
            }
          }

          functions.push({
            name,
            args,
            ret,
            tsType: tsType(ret),
            async: isAsync,
          });
          i = j;
          break;
        }
      }
    }

    if (componentMatch) {
      isComponent = true;
      // Find the next @Composable fun
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const fnLine = lines[j].trim();
        const fnMatch = fnLine.match(/fun\s+\w+\s*\(([^)]*)\)/);
        if (fnMatch) {
          const argsStr = fnMatch[1].trim();
          if (argsStr) {
            for (const part of argsStr.split(',')) {
              const argMatch = part.trim().match(/(\w+)\s*:\s*(.+)/);
              if (argMatch) {
                const pName = argMatch[1];
                const pType = argMatch[2].trim();
                // Skip callback types for props (they stay as callbacks)
                const isCallback = pType.includes('->');
                componentProps.push({
                  name: pName,
                  jsName: pName,
                  ktType: pType,
                  tsType: isCallback ? '() => void' : tsType(pType),
                  isCallback,
                });
              }
            }
          }
          i = j;
          break;
        }
      }
    }
  }

  return { functions, isComponent, componentProps };
}

module.exports = { extractKotlinExports };
