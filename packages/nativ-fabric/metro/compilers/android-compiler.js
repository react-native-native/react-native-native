/**
 * Android native compilers — builds .cpp/.rs/.kt files to arm64 .so files.
 * Mirrors dylib-compiler.js (C++), rust-compiler.js (Rust), but targets Android.
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

let _ndkPath = null;
let _resolved = false;

function resolveOnce() {
  if (_resolved) return;
  _resolved = true;

  // Find NDK
  const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (androidHome) {
    const ndkDir = path.join(androidHome, 'ndk');
    if (fs.existsSync(ndkDir)) {
      // Use the latest NDK version
      const versions = fs.readdirSync(ndkDir).sort();
      if (versions.length > 0) {
        _ndkPath = path.join(ndkDir, versions[versions.length - 1]);
      }
    }
  }

  if (_ndkPath) {
    console.log(`[ferrum] Android NDK: ${_ndkPath}`);
  } else {
    console.warn('[ferrum] Android NDK not found');
  }
}

function getNdkClang() {
  if (!_ndkPath) return null;
  // NDK toolchain clang for arm64
  const toolchain = path.join(_ndkPath, 'toolchains/llvm/prebuilt');
  const hosts = fs.readdirSync(toolchain);
  if (hosts.length === 0) return null;
  const hostDir = path.join(toolchain, hosts[0], 'bin');
  return path.join(hostDir, 'aarch64-linux-android24-clang++');
}

// ─── C++/ObjC++ → .so ──────────────────────────────────────────────────

function compileAndroidCppDylib(filepath, includePaths, exports, projectRoot) {
  resolveOnce();
  const clang = getNdkClang();
  if (!clang) return null;

  const name = path.basename(filepath).replace(/\.(cpp|cc|c)$/, '');
  const moduleId = name.toLowerCase();
  const outputDir = path.join(projectRoot, '.ferrum/dylibs');
  fs.mkdirSync(outputDir, { recursive: true });
  const soPath = path.join(outputDir, `${moduleId}.so`);

  // Generate bridge (same as iOS)
  const { extractCppExports } = require('../extractors/cpp-ast-extractor');
  const bridgePath = path.join(outputDir, `${moduleId}_android_bridge.cpp`);
  const { generateBridge } = require('../utils/bridge-generator');
  const bridgeSource = generateAndroidBridge(exports, moduleId);
  fs.writeFileSync(bridgePath, bridgeSource);

  const cmd = [
    clang,
    '-shared', '-fPIC',
    '-std=c++17',
    '-target', 'aarch64-linux-android24',
    '-DANDROID', '-D__ANDROID__',
    `-I${path.join(projectRoot, 'ferrum')}`, // RNAnywhere.h
    '-o', soPath,
    filepath,
    bridgePath,
    '-llog',
  ];

  try {
    execSync(cmd.join(' '), { stdio: 'pipe', encoding: 'utf8' });
  } catch (err) {
    console.error(`[ferrum] Android C++ compile failed: ${name}`);
    console.error((err.stderr || '').slice(0, 1000));
    return null;
  }

  // No signing needed on Android
  const size = fs.statSync(soPath).size;
  console.log(`[ferrum] Built ${moduleId}.so (${(size / 1024).toFixed(1)}KB)`);
  return soPath;
}

function generateAndroidBridge(exports, moduleId) {
  const forwardDecls = [];
  const lines = [
    '// Auto-generated Android bridge',
    '#include <cstdlib>',
    '#include <cstring>',
    '#include <string>',
    '#include <dlfcn.h>',
    '',
    '// Registry C API — resolved via dlsym (Android namespace isolation)',
    'extern "C" {',
    'typedef const char* (*RNASyncFn)(const char*);',
    'typedef void (*RNARegisterSyncFn)(const char*, const char*, RNASyncFn);',
    '}',
    '',
    '// JSON parse helpers',
    'static double _parseNumber(const char* &p) {',
    '  while (*p == \' \' || *p == \',\' || *p == \'[\') p++;',
    '  char* end; double v = strtod(p, &end); p = end; return v;',
    '}',
    'static std::string _parseString(const char* &p) {',
    '  while (*p && *p != \'"\') p++; if (*p == \'"\') p++;',
    '  std::string s; while (*p && *p != \'"\') {',
    '    if (*p == \'\\\\\' && *(p+1)) { p++; s += *p; } else { s += *p; } p++; }',
    '  if (*p == \'"\') p++; return s;',
    '}',
    '',
    'extern "C" {',
  ];

  for (const fn of exports) {
    if (fn.async) continue;

    lines.push(`static const char* rna_android_${moduleId}_${fn.name}(const char* argsJson) {`);
    lines.push('  const char* p = argsJson;');
    lines.push('  while (*p && *p != \'[\') p++; if (*p == \'[\') p++;');

    const argNames = [];
    for (const arg of fn.args) {
      const t = arg.type.replace(/const\s+/, '').replace(/\s*&\s*$/, '').trim();
      if (t === 'std::string') {
        lines.push(`  std::string ${arg.name} = _parseString(p);`);
      } else {
        lines.push(`  ${arg.type} ${arg.name} = (${arg.type})_parseNumber(p);`);
      }
      argNames.push(arg.name);
    }

    // Forward declaration
    forwardDecls.push(`extern ${fn.ret} ${fn.name}(${fn.args.map(a => a.type + ' ' + a.name).join(', ')});`);

    lines.push(`  auto result = ${fn.name}(${argNames.join(', ')});`);

    const retBase = fn.ret.replace(/const\s+/, '').replace(/\s*&\s*$/, '').trim();
    if (retBase === 'std::string') {
      lines.push('  static thread_local std::string buf;');
      lines.push('  buf = "\\\"";');
      lines.push('  for (char c : result) { if (c == \'"\') buf += "\\\\\\\""; else buf += c; }');
      lines.push('  buf += "\\\"";');
      lines.push('  return buf.c_str();');
    } else {
      lines.push('  static thread_local std::string buf;');
      lines.push('  buf = std::to_string(result);');
      lines.push('  return buf.c_str();');
    }
    lines.push('}');
    lines.push('');
  }

  // Insert forward declarations after includes
  const includeEnd = lines.findIndex(l => l.includes('extern "C" {'));
  if (includeEnd >= 0) {
    lines.splice(includeEnd, 0, ...forwardDecls, '');
  }

  // Init function — called by host after dlopen with the registry function pointer.
  // Android linker namespaces prevent dlsym(RTLD_DEFAULT) from finding host symbols.
  lines.push(`static RNARegisterSyncFn _rna_reg = nullptr;`);
  lines.push('');
  lines.push(`void rna_init(void* reg_fn) {`);
  lines.push('  _rna_reg = (RNARegisterSyncFn)reg_fn;');
  for (const fn of exports) {
    if (!fn.async) {
      lines.push(`  if (_rna_reg) _rna_reg("${moduleId}", "${fn.name}", rna_android_${moduleId}_${fn.name});`);
    }
  }
  lines.push('}');
  lines.push('');
  lines.push('} // extern "C"');

  return lines.join('\n');
}

// ─── C++ component → .so ───────────────────────────────────────────────

function compileAndroidCppComponentDylib(filepath, includePaths, projectRoot, baseName, componentProps) {
  resolveOnce();
  const clang = getNdkClang();
  if (!clang) return null;

  const componentId = `ferrum.${baseName}`;
  const outputDir = path.join(projectRoot, '.ferrum/dylibs');
  fs.mkdirSync(outputDir, { recursive: true });
  const soPath = path.join(outputDir, `ferrum_${baseName}.so`);

  const src = fs.readFileSync(filepath, 'utf8');
  const compMatch = src.match(/RNA_COMPONENT\s*\(\s*(\w+)\s*,\s*(\w+)\s*\)/);
  const propsTypeName = compMatch ? compMatch[2] : null;

  // Generate prop extraction
  const propExtractions = (componentProps || []).map(p => {
    if (p.cppType === 'std::string') {
      return `  props.${p.name} = _rna_get_string(rt, obj, "${p.jsName}", props.${p.name});`;
    } else if (p.cppType === 'double' || p.cppType === 'float' || p.cppType === 'int') {
      return `  props.${p.name} = _rna_get_number(rt, obj, "${p.jsName}", props.${p.name});`;
    } else if (p.cppType === 'bool') {
      return `  props.${p.name} = _rna_get_bool(rt, obj, "${p.jsName}", props.${p.name});`;
    }
    return '';
  }).join('\n');

  const relPath = path.relative(outputDir, filepath);
  const bridgePath = path.join(outputDir, `ferrum_${baseName}_android_bridge.cpp`);
  const renderFnName = `ferrum_${baseName}_render`;
  const bridgeSrc = `
#include "${relPath}"

extern "C" void ${renderFnName}(void* view, float width, float height,
                               void* jsi_runtime, void* jsi_props) {
  void* rt = jsi_runtime;
  void* obj = jsi_props;
${propsTypeName ? `  ${propsTypeName} props;
${propExtractions}
  mount(view, width, height, props);` : '  mount(view, width, height);'}
}

extern "C" {
  typedef void (*FerrumRenderFn)(void*, float, float, void*, void*);
  void ferrum_register_render(const char*, FerrumRenderFn);
}

__attribute__((constructor))
static void register_${baseName}() {
  ferrum_register_render("${componentId}", ${renderFnName});
}
`;
  fs.writeFileSync(bridgePath, bridgeSrc);

  const cmd = [
    clang,
    '-shared', '-fPIC',
    '-std=c++17',
    '-target', 'aarch64-linux-android24',
    '-DANDROID', '-D__ANDROID__',
    `-I${path.join(projectRoot, 'ferrum')}`,
    '-o', soPath,
    filepath,
    bridgePath,
    '-llog',
  ];

  try {
    execSync(cmd.join(' '), { stdio: 'pipe', encoding: 'utf8' });
  } catch (err) {
    console.error(`[ferrum] Android component compile failed: ${baseName}`);
    console.error((err.stderr || '').slice(0, 1000));
    return null;
  }

  const size = fs.statSync(soPath).size;
  console.log(`[ferrum] Built ferrum_${baseName}.so component (${(size / 1024).toFixed(1)}KB)`);
  return soPath;
}

// ─── Rust → .so ────────────────────────────────────────────────────────

function compileAndroidRustDylib(filepath, projectRoot) {
  resolveOnce();

  const { ensureRustCrate } = require('./rust-compiler');
  const crate = ensureRustCrate(filepath, projectRoot);
  if (!crate) return null;

  const { crateDir, moduleId } = crate;
  const name = path.basename(filepath, '.rs');
  const outputDir = path.join(projectRoot, '.ferrum/dylibs');
  fs.mkdirSync(outputDir, { recursive: true });
  const soPath = path.join(outputDir, `ferrum_${moduleId}.so`);

  const sharedTarget = path.join(projectRoot, '.ferrum/cargo-target');

  // Set up NDK linker
  const ndkLinker = getNdkClang()?.replace('clang++', 'clang');

  const cmd = [
    'cargo', 'build',
    '--manifest-path', path.join(crateDir, 'Cargo.toml'),
    '--target=aarch64-linux-android',
    '--lib',
  ];

  console.log(`[ferrum] Compiling ${name}.rs for Android via cargo...`);
  try {
    execSync(cmd.join(' '), {
      stdio: 'pipe',
      encoding: 'utf8',
      env: {
        ...process.env,
        // No -undefined dynamic_lookup on Android (that's macOS ld only).
        // No -lobjc either. Android uses -llog for logging.
        RUSTFLAGS: '-C link-arg=-llog',
        CARGO_TARGET_DIR: sharedTarget,
        CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER: ndkLinker || '',
      },
    });
  } catch (err) {
    console.error(`[ferrum] Android Rust compile failed: ${name}.rs`);
    console.error((err.stderr || '').slice(0, 2000));
    return null;
  }

  const builtSo = path.join(sharedTarget, `aarch64-linux-android/debug/libferrum_${moduleId}.so`);
  if (fs.existsSync(builtSo)) {
    fs.copyFileSync(builtSo, soPath);
    const size = fs.statSync(soPath).size;
    console.log(`[ferrum] Built ferrum_${moduleId}.so (${(size / 1024).toFixed(1)}KB)`);
    return soPath;
  }

  console.error(`[ferrum] Built .so not found: ${builtSo}`);
  return null;
}

module.exports = {
  compileAndroidCppDylib,
  compileAndroidCppComponentDylib,
  compileAndroidRustDylib,
};
