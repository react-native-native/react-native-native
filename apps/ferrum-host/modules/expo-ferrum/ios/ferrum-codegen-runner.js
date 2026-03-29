#!/usr/bin/env node

/**
 * Ferrum C ABI Codegen Runner
 *
 * Orchestrates code generation for Ferrum C ABI TurboModule bridges.
 * Called from podspec script_phase after standard RN codegen.
 *
 * Usage:
 *   node ferrum-codegen-runner.js \
 *     --codegen-path /path/to/react-native-codegen \
 *     --output-dir /path/to/generated \
 *     --schemas-dir /path/to/search/for/schemas
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Parse command-line arguments
const args = process.argv.slice(2);
const argsMap = {};
for (let i = 0; i < args.length; i += 2) {
  const key = args[i].replace(/^--/, '');
  const value = args[i + 1];
  argsMap[key] = value;
}

const codegenPath = argsMap['codegen-path'];
const outputDir = argsMap['output-dir'];
const schemasDir = argsMap['schemas-dir'];

if (!codegenPath || !outputDir || !schemasDir) {
  console.error('Usage: ferrum-codegen-runner.js --codegen-path <path> --output-dir <path> --schemas-dir <path>');
  process.exit(1);
}

/**
 * Scan directory recursively for native module schema JSON files
 * that were produced by standard react-native-codegen.
 *
 * These files typically have names like:
 * - NativeModules.json
 * - specs.json
 * - Generated*.json (from codegen output directories)
 */
function findModuleSchemas(rootDir) {
  const schemas = {};

  function scanDir(dir) {
    if (!fs.existsSync(dir)) return;

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        // Skip certain directories to avoid deep recursion
        if (entry.isDirectory()) {
          if (['node_modules', '.git', 'build', 'dist', '.ios'].includes(entry.name)) {
            continue;
          }
          scanDir(fullPath);
        } else if (entry.isFile()) {
          // Look for codegen schema files
          if (entry.name.endsWith('NativeModules.json') ||
              (entry.name.includes('schema') && entry.name.endsWith('.json'))) {

            try {
              const content = fs.readFileSync(fullPath, 'utf8');
              const parsed = JSON.parse(content);

              // Validate that this looks like a codegen schema
              if (parsed.modules && typeof parsed.modules === 'object') {
                const key = path.relative(rootDir, fullPath);
                schemas[key] = parsed;
                console.log(`Found schema: ${key}`);
              }
            } catch (e) {
              // Skip invalid JSON files
            }
          }
        }
      }
    } catch (e) {
      // Skip unreadable directories
    }
  }

  scanDir(rootDir);
  return schemas;
}

/**
 * Load the custom Ferrum codegen generator function.
 */
function loadFerrumGenerator() {
  try {
    const ferrumGeneratorPath = path.join(__dirname, 'ferrum-codegen.js');
    return require(ferrumGeneratorPath).generate;
  } catch (e) {
    console.error(`Failed to load Ferrum codegen generator: ${e.message}`);
    process.exit(1);
  }
}

/**
 * Write generated files to output directory.
 */
function writeGeneratedFiles(fileMap, outputDir) {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  let count = 0;
  fileMap.forEach((content, fileName) => {
    const filePath = path.join(outputDir, fileName);
    const dirPath = path.dirname(filePath);

    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }

    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`Wrote: ${fileName}`);
    count++;
  });

  return count;
}

/**
 * Main codegen orchestration.
 */
async function runCodegen() {
  console.log('Starting Ferrum C ABI codegen...');

  // Find all native module schemas
  const schemas = findModuleSchemas(schemasDir);

  if (Object.keys(schemas).length === 0) {
    console.log('No module schemas found. (This is OK on first build; schemas are generated during pod install)');
    return;
  }

  // Load the Ferrum generator
  const ferrumGenerator = loadFerrumGenerator();

  // Generate files for each schema
  const allFiles = new Map();
  let moduleCount = 0;

  Object.entries(schemas).forEach(([schemaPath, schema]) => {
    if (!schema.modules) {
      return;
    }

    // Use the schema path (or first module name) as the library name
    const libraryName = Object.keys(schema.modules)[0] || 'Unknown';

    console.log(`Processing schema: ${schemaPath} (library: ${libraryName})`);

    try {
      const generatedFiles = ferrumGenerator(
        libraryName,
        schema,
        undefined, // packageName
        true,      // assumeNonnull
        '',        // headerPrefix
        false      // includeGetDebugPropsImplementation
      );

      // Merge into allFiles Map
      generatedFiles.forEach((content, fileName) => {
        allFiles.set(fileName, content);
        moduleCount++;
      });
    } catch (e) {
      console.error(`Error generating code for ${schemaPath}: ${e.message}`);
      // Continue with other schemas
    }
  });

  // Write all generated files
  if (allFiles.size > 0) {
    const count = writeGeneratedFiles(allFiles, outputDir);
    console.log(`Successfully generated ${count} files for ${moduleCount} modules`);
  } else {
    console.log('No code generated (schemas may not contain native modules)');
  }
}

// Run codegen
runCodegen().catch(err => {
  console.error('Codegen failed:', err);
  process.exit(1);
});
