#!/usr/bin/env node
/**
 * Ferrum codegen runner.
 *
 * Parses TurboModule specs (TypeScript and Flow) using the same parsers as
 * react-native-codegen, then runs our C ABI bridge generator.
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

// Load parsers and our generator
const {TypeScriptParser} = require(path.join(codegenRoot, 'lib', 'parsers', 'typescript', 'parser'));
const {FlowParser} = require(path.join(codegenRoot, 'lib', 'parsers', 'flow', 'parser'));
const ferrumGenerator = require('./GenerateModuleFerrumABI');

const tsParser = new TypeScriptParser();
const flowParser = new FlowParser();

// Output directory
const outputDir = path.resolve(moduleRoot, 'ios', 'generated');
fs.mkdirSync(outputDir, {recursive: true});

console.log('[Ferrum Codegen] Project root:', projectRoot);
console.log('[Ferrum Codegen] Output dir:', outputDir);

// Find all TurboModule specs in the project and its dependencies
const specPatterns = [
  // App's own specs (TypeScript)
  path.join(projectRoot, 'src', 'specs', 'Native*.ts'),
  path.join(projectRoot, 'src', 'specs', 'Native*.tsx'),
  path.join(projectRoot, 'specs', 'Native*.ts'),

  // Installed packages (TypeScript)
  path.join(projectRoot, 'node_modules', '*', 'src', 'Native*.ts'),
  path.join(projectRoot, 'node_modules', '@*', '*', 'src', 'Native*.ts'),

  // Built-in React Native modules (Flow)
  path.join(projectRoot, 'node_modules', 'react-native', 'src', 'private', 'specs_DEPRECATED', 'modules', 'Native*.js'),
  path.join(projectRoot, 'node_modules', 'react-native', 'Libraries', '*', 'Native*.js'),
  path.join(projectRoot, 'node_modules', 'react-native', 'Libraries', 'NativeModules', 'specs', 'Native*.js'),
];

// Deduplicate by basename (re-exports point to the same spec)
let specFiles = [];
const seenBasenames = new Set();
for (const pattern of specPatterns) {
  for (const file of glob.sync(pattern)) {
    const basename = path.basename(file, path.extname(file));
    // Skip re-export wrappers (they just re-export from specs_DEPRECATED)
    const content = fs.readFileSync(file, 'utf8');
    if (content.includes('export * from') && content.includes('specs_DEPRECATED')) {
      continue;
    }
    // Skip non-TurboModule specs
    if (!content.includes('TurboModule') && !content.includes('extends TurboModule')) {
      continue;
    }
    if (!seenBasenames.has(basename)) {
      seenBasenames.add(basename);
      specFiles.push(file);
    }
  }
}

if (specFiles.length === 0) {
  console.log('[Ferrum Codegen] No TurboModule specs found, skipping');
  process.exit(0);
}

console.log(`[Ferrum Codegen] Found ${specFiles.length} spec file(s)`);

let totalBridgeFiles = 0;

for (const specFile of specFiles) {
  const basename = path.basename(specFile, path.extname(specFile));
  const ext = path.extname(specFile);
  console.log(`[Ferrum Codegen] Parsing ${basename}...`);

  try {
    // Pick parser based on file extension
    const parser = (ext === '.ts' || ext === '.tsx') ? tsParser : flowParser;
    const schema = parser.parseFile(specFile);

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
    console.warn(`[Ferrum Codegen]   Error: ${err.message}`);
  }
}

console.log(`[Ferrum Codegen] Done. Generated ${totalBridgeFiles} bridge file(s) in ${outputDir}`);
