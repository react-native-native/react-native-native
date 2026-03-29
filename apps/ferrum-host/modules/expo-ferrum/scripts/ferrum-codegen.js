#!/usr/bin/env node
/**
 * Ferrum codegen runner.
 *
 * Parses TurboModule TypeScript specs directly (same parser as RN codegen),
 * then runs our C ABI bridge generator to produce Ferrum bridge files.
 *
 * Invoked from ExpoFerrum.podspec script_phase (before compile).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const glob = require('glob');

// Resolve project root
const scriptDir = __dirname;
const moduleRoot = path.resolve(scriptDir, '..');
const projectRoot = process.env.PODS_ROOT
  ? path.resolve(process.env.PODS_ROOT, '..')
  : path.resolve(moduleRoot, '..', '..');

// Find @react-native/codegen
const codegenPaths = [
  path.join(projectRoot, 'node_modules', '@react-native', 'codegen'),
  path.join(projectRoot, '..', 'node_modules', '@react-native', 'codegen'),
];

let codegenRoot = null;
for (const p of codegenPaths) {
  if (fs.existsSync(p)) {
    codegenRoot = p;
    break;
  }
}

if (!codegenRoot) {
  console.log('[Ferrum Codegen] @react-native/codegen not found, skipping');
  process.exit(0);
}

// Load parser and our generator
const {TypeScriptParser} = require(path.join(codegenRoot, 'lib', 'parsers', 'typescript', 'parser'));
const ferrumGenerator = require('./GenerateModuleFerrumABI');

const tsParser = new TypeScriptParser();

// Output directory
const outputDir = path.resolve(moduleRoot, 'ios', 'generated');
fs.mkdirSync(outputDir, {recursive: true});

console.log('[Ferrum Codegen] Project root:', projectRoot);
console.log('[Ferrum Codegen] Codegen root:', codegenRoot);
console.log('[Ferrum Codegen] Output dir:', outputDir);

// Find all TurboModule specs in the project and its dependencies
const specPatterns = [
  // App's own specs
  path.join(projectRoot, 'src', 'specs', 'Native*.ts'),
  path.join(projectRoot, 'src', 'specs', 'Native*.tsx'),
  // Also check common locations
  path.join(projectRoot, 'specs', 'Native*.ts'),
  // Installed packages with TurboModule specs
  path.join(projectRoot, 'node_modules', '@react-native-async-storage', 'async-storage', 'src', 'Native*.ts'),
  // Generic: any package with Native* specs in src/
  path.join(projectRoot, 'node_modules', '*', 'src', 'Native*.ts'),
  path.join(projectRoot, 'node_modules', '@*', '*', 'src', 'Native*.ts'),
];

let specFiles = [];
for (const pattern of specPatterns) {
  const found = glob.sync(pattern);
  specFiles = specFiles.concat(found);
}

if (specFiles.length === 0) {
  console.log('[Ferrum Codegen] No TurboModule specs found, skipping');
  process.exit(0);
}

console.log(`[Ferrum Codegen] Found ${specFiles.length} spec file(s)`);

let totalBridgeFiles = 0;

for (const specFile of specFiles) {
  const basename = path.basename(specFile, path.extname(specFile));
  console.log(`[Ferrum Codegen] Parsing ${basename}...`);

  try {
    // Parse the TypeScript spec to a schema
    const schema = tsParser.parseFile(specFile);
    if (!schema || !schema.modules || Object.keys(schema.modules).length === 0) {
      console.log(`[Ferrum Codegen]   No modules found in ${basename}`);
      continue;
    }

    // Derive library name from the spec
    const libraryName = basename.replace(/^Native/, '').replace(/Spec$/, '') + 'Spec';

    // Run our Ferrum C ABI generator
    const files = ferrumGenerator.generate(
      libraryName,
      schema,
      undefined,  // packageName
      true,       // assumeNonnull (iOS)
      undefined,  // headerPrefix
    );

    // Write output files
    for (const [fileName, content] of files) {
      const outputPath = path.join(outputDir, fileName);
      fs.writeFileSync(outputPath, content);
      console.log(`[Ferrum Codegen]   -> ${fileName}`);
      totalBridgeFiles++;
    }
  } catch (err) {
    console.warn(`[Ferrum Codegen]   Error processing ${basename}: ${err.message}`);
  }
}

console.log(`[Ferrum Codegen] Done. Generated ${totalBridgeFiles} bridge file(s) in ${outputDir}`);
