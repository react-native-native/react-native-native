/**
 * static-compiler.js — Production build: generates bridges, compiles Rust into
 * a single static library, and writes a podspec/Gradle config.
 *
 * All output goes to .nativ/generated/:
 *   - ReactNativeNativeUserCode.podspec
 *   - bridges/ios/*.cpp, *.mm, *.c
 *   - bridges/android/*.cpp, *.c
 *   - release/libnativ_user.a  (single unified Rust lib)
 *   - kotlin-src/*.kt
 *
 * Invoked by:
 *   - CocoaPods script phase (iOS): node ferrum/static-compiler.js --platform ios
 *   - Gradle pre-build task (Android): node ferrum/static-compiler.js --platform android
 */

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

// Reuse existing extractors
const { extractCppExports, isCppComponent, extractCppComponentProps } = require('../extractors/cpp-ast-extractor');
const { extractRustExports } = require('../extractors/rust-extractor');
const { extractSwiftExports } = require('./swift-compiler');
const { extractKotlinExports } = require('../extractors/kotlin-extractor');

// Reuse existing bridge generators
const { generateBridge } = require('./dylib-compiler');

// ─── CLI ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const platformIdx = args.indexOf('--platform');
const platform = platformIdx >= 0 ? args[platformIdx + 1] : 'ios';
const projectRoot = args.includes('--root')
  ? args[args.indexOf('--root') + 1]
  : process.cwd();

const isIOS = platform === 'ios';
const isAndroid = platform === 'android';

const genDir = path.join(projectRoot, '.nativ/generated');
const bridgeDir = path.join(genDir, 'bridges', isAndroid ? 'android' : 'ios');
const releaseDir = path.join(genDir, 'release');
fs.mkdirSync(bridgeDir, { recursive: true });
fs.mkdirSync(releaseDir, { recursive: true });

console.log(`[nativ] Static compiler: platform=${platform}, root=${projectRoot}`);

// ─── Scan for user native files ────────────────────────────────────────

function findUserFiles(exts) {
  const results = [];
  const ignore = ['node_modules', '.nativ', 'modules', 'ios', 'android', 'vendor'];

  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (ignore.includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (exts.some(ext => entry.name.endsWith(ext))) {
        results.push(full);
      }
    }
  }
  walk(projectRoot);
  return results;
}

// ─── C++/ObjC++ bridge generation ──────────────────────────────────────
// Bridges are source files compiled by Xcode/Gradle alongside user code.

function buildCppBridges() {
  // .mm (ObjC++) is iOS-only, .cpp/.cc work on both platforms
  const exts = isIOS ? ['.cpp', '.cc', '.mm'] : ['.cpp', '.cc'];
  const cppFiles = findUserFiles(exts);
  if (cppFiles.length === 0) return;

  for (const filepath of cppFiles) {
    if (isCppComponent(filepath)) {
      const baseName = path.basename(filepath).replace(/\.(cpp|cc|mm)$/, '').toLowerCase();
      const componentId = `ferrum.${baseName}`;
      const cppProps = extractCppComponentProps(filepath);
      const propsTypeName = (() => {
        const src = fs.readFileSync(filepath, 'utf8');
        const m = src.match(/NATIV_COMPONENT\s*\(\s*(\w+)\s*,\s*(\w+)\s*\)/);
        return m ? m[2] : null;
      })();

      const propExtractions = (cppProps || []).map(p => {
        if (p.cppType === 'std::string') return `  props.${p.name} = _nativ_get_string(rt, obj, "${p.jsName}", props.${p.name});`;
        if (['double', 'float', 'int'].includes(p.cppType)) return `  props.${p.name} = _nativ_get_number(rt, obj, "${p.jsName}", props.${p.name});`;
        if (p.cppType === 'bool') return `  props.${p.name} = _nativ_get_bool(rt, obj, "${p.jsName}", props.${p.name});`;
        return '';
      }).join('\n');

      const renderFnName = `nativ_${baseName}_render`;
      const bridgeSrc = `
// Auto-generated production component bridge for ${baseName}
#include "${path.resolve(filepath)}"

extern "C"
void ${renderFnName}(void* view, float width, float height,
                   void* jsi_runtime, void* jsi_props) {
  void* rt = jsi_runtime;
  void* obj = jsi_props;
${propsTypeName ? `  ${propsTypeName} props;\n${propExtractions}\n  mount(view, width, height, props);` : '  mount(view, width, height);'}
}

extern "C" {
  typedef void (*NativRenderFn)(void*, float, float, void*, void*);
  void nativ_register_render(const char*, NativRenderFn);
}

__attribute__((constructor, used))
static void register_${baseName}() {
  nativ_register_render("${componentId}", ${renderFnName});
}
`;
      const ext = filepath.endsWith('.mm') ? 'mm' : 'cpp';
      fs.writeFileSync(path.join(bridgeDir, `nativ_${baseName}_bridge.${ext}`), bridgeSrc);
      console.log(`[nativ] Bridge: ${baseName} (component)`);
    } else {
      const exports = extractCppExports(filepath, []);
      if (exports.length === 0) continue;

      const rel = path.relative(projectRoot, filepath);
      const moduleId = rel.replace(/\.(cpp|cc|mm)$/, '').replace(/[\/\\]/g, '_').replace(/[^a-zA-Z0-9_]/g, '_');
      // Include user source in the bridge so functions are compiled in the same
      // translation unit. In dev mode, -undefined dynamic_lookup resolves them;
      // in production static linking, they must be compiled directly.
      const bridgeSrc = generateBridge(exports, moduleId);
      const userInclude = `#include "${path.resolve(filepath)}"\n\n`;
      const ext = filepath.endsWith('.mm') ? 'mm' : 'cpp';
      fs.writeFileSync(path.join(bridgeDir, `${moduleId}_bridge.${ext}`), userInclude + bridgeSrc);
      console.log(`[nativ] Bridge: ${moduleId} (${exports.length} functions)`);
    }
  }
}

// ─── Rust: single unified static library ───────────────────────────────
// All user .rs files are compiled into ONE .a to avoid duplicate stdlib symbols.

function buildRustStatic() {
  const rsFiles = findUserFiles(['.rs']);
  if (rsFiles.length === 0) return;

  // Android builds for all ABIs; iOS just arm64
  const abiTargets = isAndroid ? [
    { abi: 'arm64-v8a',    rust: 'aarch64-linux-android',   linkerPrefix: 'aarch64-linux-android' },
    { abi: 'armeabi-v7a',  rust: 'armv7-linux-androideabi',  linkerPrefix: 'armv7a-linux-androideabi' },
    { abi: 'x86_64',       rust: 'x86_64-linux-android',     linkerPrefix: 'x86_64-linux-android' },
    { abi: 'x86',          rust: 'i686-linux-android',        linkerPrefix: 'i686-linux-android' },
  ] : [
    { abi: 'arm64',        rust: 'aarch64-apple-ios' },
  ];

  // Check if all outputs are up to date
  const outputPaths = abiTargets.map(t => {
    const dir = isAndroid ? path.join(releaseDir, t.abi) : releaseDir;
    return path.join(dir, 'libnativ_user.a');
  });
  const allUpToDate = outputPaths.every(p => {
    if (!fs.existsSync(p)) return false;
    const libMtime = fs.statSync(p).mtimeMs;
    return rsFiles.every(f => fs.statSync(f).mtimeMs < libMtime);
  });
  if (allUpToDate) {
    console.log(`[nativ] Rust: all targets up to date, skipping`);
    return;
  }

  // Unified crate: all user .rs files compiled as modules in a single crate.
  // Shared types (NativeViewHandle, NativeView) come from rna-core via crate root.
  // No duplicate stdlib — one .a file.
  const { generateFunctionWrapper, generateComponentWrapper } = require('./rust-compiler');
  const { extractRustExports: _extractRust } = require('../extractors/rust-extractor');

  const unifiedDir = path.join(projectRoot, '.nativ/build/nativ_unified');
  fs.mkdirSync(path.join(unifiedDir, 'src'), { recursive: true });

  // Forward deps from root Cargo.toml, enabling "unified" feature on rna-core
  let rootDeps = '';
  try {
    const rootToml = fs.readFileSync(path.join(projectRoot, 'Cargo.toml'), 'utf8');
    const depsSection = rootToml.match(/\[dependencies\]([\s\S]*?)(?:\n\[|\n*$)/);
    if (depsSection) {
      rootDeps = depsSection[1]
        .replace(/path\s*=\s*"([^"]+)"/g, (_, p) => {
          const absPath = path.resolve(projectRoot, p);
          const relPath = path.relative(unifiedDir, absPath);
          return `path = "${relPath}"`;
        });
    }
  } catch {}

  fs.writeFileSync(path.join(unifiedDir, 'Cargo.toml'), `[package]
name = "ferrum-user"
version = "0.1.0"
edition = "2024"

[lib]
crate-type = ["staticlib"]

[workspace]

[dependencies]
${rootDeps}

[profile.release]
opt-level = "z"
lto = true
`);

  // Generate each user file as a module with unified = true (imports from crate root)
  const modules = [];
  for (const filepath of rsFiles) {
    const { functions, isComponent } = _extractRust(filepath);
    if (!isComponent && functions.length === 0) continue;

    const name = path.basename(filepath, '.rs').toLowerCase();
    const userSrc = fs.readFileSync(filepath, 'utf8');

    let moduleSrc;
    if (isComponent) {
      moduleSrc = generateComponentWrapper(userSrc, name, { unified: true });
    } else {
      moduleSrc = generateFunctionWrapper(userSrc, functions, name, { unified: true });
    }
    fs.writeFileSync(path.join(unifiedDir, 'src', `${name}.rs`), moduleSrc);
    modules.push(name);
  }

  if (modules.length === 0) {
    console.log('[nativ] Rust: no exported modules found');
    return;
  }

  // lib.rs: re-export shared types from rna-core, declare user modules
  const libRs = [
    '// Auto-generated by React Native Native — do not edit',
    '#![allow(unused, non_snake_case, unused_unsafe)]',
    '',
    '// Canonical shared types — all modules import from here via use crate::',
    'pub use nativ_core::prelude::*;',
    '',
    '// User component/function modules',
    ...modules.map(m => `pub mod ${m};`),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(unifiedDir, 'src/lib.rs'), libRs);

  // Build for each ABI target
  const sharedTarget = path.join(projectRoot, '.nativ/cargo-target');

  // Resolve NDK toolchain once for Android
  let ndkBinDir = null;
  if (isAndroid) {
    const androidHome = process.env.ANDROID_HOME || path.join(process.env.HOME, 'Library/Android/sdk');
    const ndkDir = path.join(androidHome, 'ndk');
    try {
      const versions = fs.readdirSync(ndkDir).sort();
      if (versions.length > 0) {
        const toolchain = path.join(ndkDir, versions[versions.length - 1], 'toolchains/llvm/prebuilt');
        const hosts = fs.readdirSync(toolchain);
        if (hosts.length > 0) ndkBinDir = path.join(toolchain, hosts[0], 'bin');
      }
    } catch {}
    if (!ndkBinDir) {
      console.error('[nativ] Android NDK not found — cannot build Rust for Android');
      return;
    }
  }

  for (const { abi, rust: target, linkerPrefix } of abiTargets) {
    const outputDir = isAndroid ? path.join(releaseDir, abi) : releaseDir;
    fs.mkdirSync(outputDir, { recursive: true });
    const outputLib = path.join(outputDir, 'libnativ_user.a');

    const cmd = [
      'cargo', 'build', '--release',
      '--manifest-path', path.join(unifiedDir, 'Cargo.toml'),
      `--target=${target}`,
      '--lib',
    ];

    const env = { ...process.env, CARGO_TARGET_DIR: sharedTarget };
    if (isIOS) {
      env.RUSTFLAGS = '--cfg unified -C link-arg=-undefined -C link-arg=dynamic_lookup';
    }
    if (isAndroid) {
      // Set the linker for this specific target
      const envKey = `CARGO_TARGET_${target.toUpperCase().replace(/-/g, '_')}_LINKER`;
      env[envKey] = path.join(ndkBinDir, `${linkerPrefix}24-clang`);
      env.RUSTFLAGS = '--cfg unified -C link-arg=-llog';
    }

    console.log(`[nativ] Compiling Rust (${modules.length} modules, ${abi} → ${target})...`);
    try {
      execSync(cmd.join(' '), { stdio: 'pipe', encoding: 'utf8', env });
    } catch (err) {
      console.error(`[nativ] Rust compile failed for ${abi}`);
      console.error((err.stderr || '').slice(0, 3000));
      continue;
    }

    const builtLib = path.join(sharedTarget, target, 'release/libnativ_user.a');
    if (fs.existsSync(builtLib)) {
      fs.copyFileSync(builtLib, outputLib);
      const size = fs.statSync(outputLib).size;
      console.log(`[nativ] Built ${abi}/libnativ_user.a (${(size / 1024).toFixed(1)}KB)`);
    } else {
      console.error(`[nativ] libnativ_user.a not found at ${builtLib}`);
    }
  }
}

// ─── Swift bridge generation ───────────────────────────────────────────

function buildSwiftBridges() {
  if (!isIOS) return;
  const swiftFiles = findUserFiles(['.swift']);
  if (swiftFiles.length === 0) return;

  for (const filepath of swiftFiles) {
    const name = path.basename(filepath, '.swift');
    const moduleId = name.toLowerCase();
    const src = fs.readFileSync(filepath, 'utf8');
    const isComp = src.includes('@nativ_component') || src.includes('nativ::component');

    if (isComp) {
      const renderFnName = `nativ_${moduleId}_render`;
      fs.writeFileSync(path.join(bridgeDir, `${moduleId}_reg.c`), `
typedef void (*NativRenderFn)(void*, float, float, void*, void*);
extern void nativ_register_render(const char*, NativRenderFn);
extern void ${renderFnName}(void*, float, float, void*, void*);

__attribute__((constructor, used))
void nativ_register_${moduleId}(void) {
  nativ_register_render("nativ.${moduleId}", ${renderFnName});
}
`);
      console.log(`[nativ] Swift bridge: ${moduleId} (component)`);
    } else {
      const exports = extractSwiftExports(filepath);
      if (exports.length === 0) continue;

      const declarations = exports.map(fn =>
        `extern const char* nativ_swift_${moduleId}_${fn.name}(const char*);`
      ).join('\n');
      const registrations = exports.map(fn =>
        `  nativ_register_sync("${moduleId}", "${fn.name}", nativ_swift_${moduleId}_${fn.name});`
      ).join('\n');

      fs.writeFileSync(path.join(bridgeDir, `${moduleId}_reg.c`), `
typedef const char* (*NativSyncFn)(const char*);
extern void nativ_register_sync(const char*, const char*, NativSyncFn);
${declarations}

__attribute__((constructor, used))
void nativ_register_${moduleId}(void) {
${registrations}
}
`);
      // Generate Swift @_cdecl wrappers that the C registration file references
      let swiftWrappers = 'import Foundation\n';
      swiftWrappers += exports.map(fn => {
        const retType = fn.ret || 'Void';
        const argPassthrough = fn.args.map(a => a.name).join(', ');
        let resultExpr;
        if (retType === 'String') resultExpr = `return UnsafePointer(strdup("\\"" + result + "\\"")!)`;
        else if (retType === 'Bool') resultExpr = `return UnsafePointer(strdup(result ? "true" : "false")!)`;
        else if (retType === 'Void') resultExpr = `return UnsafePointer(strdup("null")!)`;
        else resultExpr = `return UnsafePointer(strdup(String(result))!)`;
        return `
@_cdecl("${fn.cdeclName}")
func _nativ_${fn.name}(_ argsJson: UnsafePointer<CChar>) -> UnsafePointer<CChar> {
    let result = ${fn.name}(${argPassthrough})
    ${resultExpr}
}`;
      }).join('\n');
      fs.writeFileSync(path.join(bridgeDir, `${moduleId}_bridge.swift`), swiftWrappers);

      console.log(`[nativ] Swift bridge: ${moduleId} (${exports.length} functions)`);
    }
  }
}

// ─── Kotlin wrapper generation (Android only) ──────────────────────────

function buildKotlinSources() {
  if (!isAndroid) return [];
  const ktFiles = findUserFiles(['.kt']);
  if (ktFiles.length === 0) return [];

  const ktSrcDir = path.join(genDir, 'kotlin-src/com/nativfabric/generated');
  fs.mkdirSync(ktSrcDir, { recursive: true });
  const registeredModules = [];

  for (const filepath of ktFiles) {
    const { functions, isComponent } = extractKotlinExports(filepath);
    const baseName = path.basename(filepath, '.kt');
    const moduleId = baseName.toLowerCase();
    const className = `RnaModule_${moduleId}`;
    const userSrc = fs.readFileSync(filepath, 'utf8');

    if (isComponent) {
      const cleanSrc = userSrc
        .replace(/\/\/\s*@nativ_component\s*\n/g, '')
        .replace(/^package\s+[^\n]+\n/m, '')
        .replace(/^import\s+[^\n]+\n/gm, '');
      const userImports = [...userSrc.matchAll(/^(import\s+[^\n]+)\n/gm)].map(m => m[1]);
      const isCompose = userSrc.includes('@Composable');

      if (isCompose) {
        // Compose: Gradle compiles with real Compose plugin (no pre-transform supplement)
        // Parse Composable function params for prop extraction
        const compFnMatch = cleanSrc.match(/@Composable\s+fun\s+(\w+)\s*\(([^)]*)\)/);
        const compFnName = compFnMatch ? compFnMatch[1] : baseName;
        const compParams = compFnMatch && compFnMatch[2] ? compFnMatch[2].trim() : '';

        let compCall;
        if (compParams) {
          const args = compParams.split(',').map(p => p.trim()).filter(Boolean);
          const argExprs = args.map(p => {
            const m = p.match(/(\w+)\s*:\s*(.+)/);
            if (!m) return null;
            const [, pName, pType] = m;
            const t = pType.trim();
            if (t === 'String') return `                ${pName} = props["${pName}"] as? String ?: ""`;
            if (t === 'Int') return `                ${pName} = (props["${pName}"] as? Number)?.toInt() ?: 0`;
            if (t === 'Float' || t === 'Double') return `                ${pName} = (props["${pName}"] as? Number)?.toDouble() ?: 0.0`;
            if (t === 'Boolean') return `                ${pName} = props["${pName}"] as? Boolean ?: false`;
            if (t.includes('->')) return `                ${pName} = {}`;
            return `                ${pName} = props["${pName}"]`;
          }).filter(Boolean);
          compCall = `            ${compFnName}(\n${argExprs.join(',\n')}\n            )`;
        } else {
          compCall = `            ${compFnName}()`;
        }

        const wrapper = [
          `package com.nativfabric.generated`,
          '', 'import android.view.ViewGroup', 'import android.widget.FrameLayout',
          'import androidx.compose.runtime.*', 'import androidx.compose.ui.platform.ComposeView',
          ...userImports, '', cleanSrc, '',
          `object ${className} {`, '    @JvmStatic',
          '    fun render(parent: ViewGroup, props: Map<String, Any?>) {',
          '        val composeView = ComposeView(parent.context)',
          '        composeView.setContent {',
          compCall,
          '        }',
          '        parent.addView(composeView, FrameLayout.LayoutParams(',
          '            FrameLayout.LayoutParams.MATCH_PARENT,',
          '            FrameLayout.LayoutParams.MATCH_PARENT))', '    }', '}',
        ].join('\n');
        fs.writeFileSync(path.join(ktSrcDir, `${className}.kt`), wrapper);
      } else {
        const fnMatch = cleanSrc.match(/fun\s+(\w+)\s*\(\s*parent\s*:/);
        const fnName = fnMatch ? fnMatch[1] : baseName;
        const wrapper = [
          `package com.nativfabric.generated`, '', ...userImports, '', cleanSrc, '',
          `object ${className} {`, '    @JvmStatic',
          '    fun render(parent: android.view.ViewGroup, props: Map<String, Any?>) {',
          `        ${fnName}(parent, props)`, '    }', '}',
        ].join('\n');
        fs.writeFileSync(path.join(ktSrcDir, `${className}.kt`), wrapper);
      }
      registeredModules.push(moduleId);
      console.log(`[nativ] Kotlin wrapper: ${moduleId} (component)`);

    } else if (functions.length > 0) {
      const cleanSrc = userSrc
        .replace(/\/\/\s*@nativ_export\s*\([^)]*\)\s*\n/g, '')
        .replace(/^package\s+[^\n]+\n/m, '');

      const lines = [
        `package com.nativfabric.generated`, '', cleanSrc, '',
        `private fun _parseArgs(json: String): List<String> {`,
        `    val s = json.trim().removePrefix("[").removeSuffix("]")`,
        `    if (s.isBlank()) return emptyList()`,
        `    val result = mutableListOf<String>()`,
        `    var i = 0; var inStr = false; var esc = false; val buf = StringBuilder()`,
        `    while (i < s.length) { val c = s[i]; when {`,
        `        esc -> { buf.append(c); esc = false }; c == '\\\\' -> esc = true`,
        `        c == '"' -> inStr = !inStr; c == ',' && !inStr -> { result.add(buf.toString().trim()); buf.clear() }`,
        `        else -> buf.append(c) }; i++ }`,
        `    if (buf.isNotEmpty()) result.add(buf.toString().trim()); return result }`,
        '',
        `object ${className} {`, '    @JvmStatic',
        '    fun dispatch(fnName: String, argsJson: String): String {',
        '        val args = _parseArgs(argsJson)', '        return when (fnName) {',
      ];
      for (const fn of functions) {
        const argExprs = fn.args.map((a, i) => {
          switch (a.type) {
            case 'Int': return `args[${i}].toInt()`;
            case 'Long': return `args[${i}].toLong()`;
            case 'Float': return `args[${i}].toFloat()`;
            case 'Double': return `args[${i}].toDouble()`;
            case 'Boolean': return `args[${i}].toBoolean()`;
            default: return `args[${i}]`;
          }
        });
        const call = `${fn.name}(${argExprs.join(', ')})`;
        if (fn.ret === 'String') lines.push(`            "${fn.name}" -> "\\"" + ${call} + "\\""`)
        else if (fn.ret === 'Unit') lines.push(`            "${fn.name}" -> { ${call}; "null" }`)
        else lines.push(`            "${fn.name}" -> ${call}.toString()`)
      }
      lines.push('            else -> "null"', '        }', '    }', '}');
      fs.writeFileSync(path.join(ktSrcDir, `${className}.kt`), lines.join('\n'));
      registeredModules.push(moduleId);
      console.log(`[nativ] Kotlin wrapper: ${moduleId} (${functions.length} functions)`);
    }
  }
  return registeredModules;
}

// ─── Run ───────────────────────────────────────────────────────────────

const rustOnly = args.includes('--rust-only');
const t0 = Date.now();
if (!rustOnly) buildCppBridges();
buildRustStatic();
if (!rustOnly) buildSwiftBridges();
const kotlinModules = rustOnly ? [] : buildKotlinSources();

// Generate Kotlin registry class that registers all modules at init time.
// This is compiled by Gradle and auto-registers when the class is loaded.
if (kotlinModules && kotlinModules.length > 0) {
  const ktSrcDir = path.join(genDir, 'kotlin-src/com/nativfabric/generated');
  const registrations = kotlinModules.map(moduleId => {
    const className = `RnaModule_${moduleId}`;
    return `        try {
            val clazz = Class.forName("com.nativfabric.generated.${className}")
            try {
                val dispatch = clazz.getMethod("dispatch", String::class.java, String::class.java)
                com.nativfabric.NativRuntime.registerKotlinDispatch("${moduleId}", dispatch)
            } catch (_: NoSuchMethodException) {}
            try {
                val render = clazz.getMethod("render", android.view.ViewGroup::class.java, Map::class.java)
                com.nativfabric.NativRuntime.registerKotlinRenderer("nativ.${moduleId}", render)
            } catch (_: NoSuchMethodException) {}
        } catch (e: Exception) {
            android.util.Log.w("NativRegistry", "Module ${moduleId}: \${e.message}")
        }`;
  }).join('\n');

  fs.writeFileSync(path.join(ktSrcDir, 'NativModuleRegistry.kt'), `package com.nativfabric.generated

object NativModuleRegistry {
    init {
${registrations}
    }

    fun ensure() {} // Called to trigger class loading
}
`);
  console.log(`[nativ] Kotlin registry: ${kotlinModules.length} modules`);
}

console.log(`[nativ] Static compilation done in ${Date.now() - t0}ms`);
