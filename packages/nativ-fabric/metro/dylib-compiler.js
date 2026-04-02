/**
 * Compiles a .cpp/.mm file to a signed arm64 dylib.
 * Called directly by the transformer (same process — no IPC needed).
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

let _sdkPath = null;
let _signingIdentity = null;
let _resolved = false;

function resolveOnce(projectRoot) {
  if (_resolved) return;
  _resolved = true;

  try {
    _sdkPath = execSync('xcrun --sdk iphoneos --show-sdk-path', {
      encoding: 'utf8',
    }).trim();
  } catch {
    try {
      _sdkPath = execSync('xcrun --sdk iphonesimulator --show-sdk-path', {
        encoding: 'utf8',
      }).trim();
    } catch {
      console.error('[ferrum] No iOS SDK found');
    }
  }

  // Find the signing identity that matches the app's team ID.
  try {
    // Read team ID — app.json first (works without prebuild / with EAS),
    // then fall back to project.pbxproj
    let appTeamId = null;

    const root = projectRoot || '.';
    try {
      const appJson = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
      appTeamId = appJson?.expo?.ios?.appleTeamId || null;
    } catch {}

    if (!appTeamId) {
      try {
        const pbxprojs = execSync(
          `find "${root}/ios" -name "project.pbxproj" -maxdepth 3 2>/dev/null`,
          { encoding: 'utf8' }
        ).trim().split('\n').filter(Boolean);
        for (const pbx of pbxprojs) {
          try {
            const content = fs.readFileSync(pbx, 'utf8');
            const m = content.match(/DEVELOPMENT_TEAM\s*=\s*(\w+)/);
            if (m) { appTeamId = m[1]; break; }
          } catch {}
        }
      } catch {}
    }

    if (appTeamId) {
      // Find the codesigning identity whose certificate OU matches the team
      const identities = execSync('security find-identity -v -p codesigning', {
        encoding: 'utf8',
      });
      const idEntries = [...identities.matchAll(/([A-F0-9]{40})\s+"([^"]+)"/g)];

      for (const [, , name] of idEntries) {
        try {
          const certSubject = execSync(
            `security find-certificate -c "${name}" -p 2>/dev/null | openssl x509 -noout -subject 2>/dev/null`,
            { encoding: 'utf8' }
          );
          if (certSubject.includes(`OU=${appTeamId}`)) {
            _signingIdentity = name;
            console.log(`[ferrum] Signing: ${name} (team ${appTeamId})`);
            break;
          }
        } catch {}
      }
    }

    // Fallback: first available identity
    if (!_signingIdentity) {
      const match = execSync('security find-identity -v -p codesigning', {
        encoding: 'utf8',
      }).match(/"(Apple Development:[^"]+)"/);
      if (match) _signingIdentity = match[1];
    }
  } catch {}
}

/**
 * Compile a .cpp/.mm file + generated bridge to a signed dylib.
 * Returns the dylib path, or null on failure.
 */
function compileDylib(filepath, includePaths, exports, projectRoot) {
  resolveOnce(projectRoot);
  if (!_sdkPath) return null;

  const rel = path.relative(projectRoot, filepath);
  const moduleId = rel
    .replace(/\.(cpp|cc|mm)$/, '')
    .replace(/[\/\\]/g, '_')
    .replace(/[^a-zA-Z0-9_]/g, '_');

  const outputDir = path.join(projectRoot, '.ferrum/dylibs');
  fs.mkdirSync(outputDir, { recursive: true });
  const dylibPath = path.join(outputDir, `${moduleId}.dylib`);

  // Generate bridge source
  const bridgePath = path.join(outputDir, `${moduleId}_bridge.cpp`);
  const bridgeSource = generateBridge(exports, moduleId);
  fs.writeFileSync(bridgePath, bridgeSource);

  const isObjCpp = filepath.endsWith('.mm');
  const lang = isObjCpp ? 'objective-c++' : 'c++';

  // Filter out -isysroot from include paths (we provide our own)
  const filteredPaths = [];
  for (let i = 0; i < includePaths.length; i++) {
    if (includePaths[i] === '-isysroot') { i++; continue; }
    filteredPaths.push(includePaths[i]);
  }

  const cmd = [
    'clang++',
    '-x', lang,
    '-std=c++17',
    '-arch', 'arm64',
    '-dynamiclib',
    '-fPIC',
    '-isysroot', _sdkPath,
    ...filteredPaths,
    '-undefined', 'dynamic_lookup',
    '-o', dylibPath,
    filepath,
    bridgePath,
  ];

  // Auto-detect frameworks from #import/#include directives
  if (isObjCpp) {
    const src = fs.readFileSync(filepath, 'utf8');
    const frameworkImports = src.matchAll(/#(?:import|include)\s*<(\w+)\//g);
    // System header dirs that are NOT frameworks
    const notFrameworks = new Set([
      'sys', 'mach', 'os', 'dispatch', 'objc', 'libkern',
      'arm', 'i386', 'machine', 'net', 'netinet', 'arpa',
    ]);
    const frameworks = new Set();
    for (const [, fw] of frameworkImports) {
      if (!notFrameworks.has(fw)) {
        frameworks.add(fw);
      }
    }
    // Always include Foundation for ObjC++
    frameworks.add('Foundation');
    for (const fw of frameworks) {
      cmd.push('-framework', fw);
    }
  }

  // Suppress deprecation warnings — they cause noise but aren't errors
  cmd.push('-Wno-deprecated-declarations');

  try {
    execSync(cmd.join(' '), { stdio: 'pipe', encoding: 'utf8' });
  } catch (err) {
    console.error(`[ferrum] dylib compile failed: ${path.basename(filepath)}`);
    console.error((err.stderr || '').slice(0, 1000));
    return null;
  }

  // Sign with the same identity/team as the app
  if (_signingIdentity) {
    try {
      execSync(`codesign -fs "${_signingIdentity}" "${dylibPath}"`, { stdio: 'pipe' });
    } catch {
      // Fallback: ad-hoc sign
      try {
        execSync(`codesign -fs - "${dylibPath}"`, { stdio: 'pipe' });
      } catch {}
    }
  }

  const size = fs.statSync(dylibPath).size;
  console.log(`[ferrum] Built ${moduleId}.dylib (${(size / 1024).toFixed(1)}KB)`);
  return dylibPath;
}

function generateBridge(exports, moduleId) {
  const lines = [
    '// Hot-reload bridge — auto-generated',
    '#include <string>',
    '#include <cstdlib>',
    '',
    '// Forward declarations',
  ];

  for (const fn of exports) {
    const argTypes = fn.args.map(a => a.type + ' ' + a.name).join(', ');
    lines.push(`extern ${fn.ret} ${fn.name}(${argTypes});`);
  }

  lines.push('', 'extern "C" {');
  lines.push('typedef const char* (*RNASyncFn)(const char*);');
  lines.push('void rna_register_sync(const char*, const char*, RNASyncFn);');
  lines.push('');

  // JSON parse helpers
  lines.push('static double _parseNumber(const char* &p) {');
  lines.push('  while (*p == \' \' || *p == \',\' || *p == \'[\') p++;');
  lines.push('  char* end; double v = strtod(p, &end); p = end; return v;');
  lines.push('}');
  lines.push('static std::string _parseString(const char* &p) {');
  lines.push('  while (*p && *p != \'"\') p++; if (*p == \'"\') p++;');
  lines.push('  std::string s; while (*p && *p != \'"\') {');
  lines.push('    if (*p == \'\\\\\' && *(p+1)) { p++; s += *p; } else { s += *p; } p++; }');
  lines.push('  if (*p == \'"\') p++; return s;');
  lines.push('}');
  lines.push('');

  for (const fn of exports) {
    if (fn.async) continue; // TODO: async support

    lines.push(`static const char* rna_hot_${moduleId}_${fn.name}(const char* argsJson) {`);
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

  // Constructor
  lines.push('__attribute__((constructor))');
  lines.push(`static void rna_hot_register_${moduleId}() {`);
  for (const fn of exports) {
    if (!fn.async) {
      lines.push(`  rna_register_sync("${moduleId}", "${fn.name}", rna_hot_${moduleId}_${fn.name});`);
    }
  }
  lines.push('}');
  lines.push('');
  lines.push('} // extern "C"');

  return lines.join('\n');
}

/**
 * Compile an ObjC++/C++ component file to a signed dylib.
 * The file defines a props struct + mount() function.
 * The bridge auto-generates ferrum_render that extracts props from the snapshot.
 */
function compileCppComponentDylib(filepath, includePaths, projectRoot, baseName, componentProps) {
  resolveOnce(projectRoot);
  if (!_sdkPath) return null;

  const componentId = `ferrum.${baseName}`;
  const outputDir = path.join(projectRoot, '.ferrum/dylibs');
  fs.mkdirSync(outputDir, { recursive: true });
  const dylibPath = path.join(outputDir, `ferrum_${baseName}.dylib`);

  // Find the props struct name from RNA_COMPONENT macro
  const src = fs.readFileSync(filepath, 'utf8');
  const compMatch = src.match(/RNA_COMPONENT\s*\(\s*(\w+)\s*,\s*(\w+)\s*\)/);
  const propsTypeName = compMatch ? compMatch[2] : null;

  // Generate prop extraction code
  const propExtractions = (componentProps || []).map(p => {
    if (p.cppType === 'std::string') {
      return `  props.${p.name} = _rna_get_string(rt, obj, "${p.jsName}", props.${p.name});`;
    } else if (p.cppType === 'double' || p.cppType === 'float' || p.cppType === 'int') {
      return `  props.${p.name} = _rna_get_number(rt, obj, "${p.jsName}", props.${p.name});`;
    } else if (p.cppType === 'bool') {
      return `  props.${p.name} = _rna_get_bool(rt, obj, "${p.jsName}", props.${p.name});`;
    } else if (p.cppType === 'std::function<void()>') {
      return `  props.${p.name} = _rna_get_callback(rt, obj, "${p.jsName}");`;
    }
    return `  // unknown type for ${p.name}: ${p.cppType}`;
  }).join('\n');

  // Generate bridge that auto-extracts props and calls mount()
  const bridgePath = path.join(outputDir, `ferrum_${baseName}_bridge.mm`);
  const relPath = path.relative(outputDir, filepath);
  const renderFnName = `ferrum_${baseName}_render`;
  const bridgeSrc = `
// Auto-generated component bridge for ${baseName}
#include "${relPath}"

// Auto-generated render function — unique per component for static linking compat
extern "C"
void ${renderFnName}(void* view, float width, float height,
                   void* jsi_runtime, void* jsi_props) {
  void* rt = jsi_runtime;
  void* obj = jsi_props;
${propsTypeName ? `  ${propsTypeName} props;
${propExtractions}
  mount(view, width, height, props);` : `  mount(view, width, height);`}
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

  const isObjCpp = filepath.endsWith('.mm');
  const lang = isObjCpp ? 'objective-c++' : 'c++';

  const filteredPaths = [];
  for (let i = 0; i < includePaths.length; i++) {
    if (includePaths[i] === '-isysroot') { i++; continue; }
    filteredPaths.push(includePaths[i]);
  }

  const cmd = [
    'clang++',
    '-x', lang,
    '-std=c++17',
    '-arch', 'arm64',
    '-dynamiclib',
    '-fPIC',
    '-isysroot', _sdkPath,
    ...filteredPaths,
    '-undefined', 'dynamic_lookup',
    '-Wno-deprecated-declarations',
    '-o', dylibPath,
    filepath,
    bridgePath,
  ];

  // Auto-detect frameworks
  if (isObjCpp) {
    const src = fs.readFileSync(filepath, 'utf8');
    const notFrameworks = new Set(['sys', 'mach', 'os', 'dispatch', 'objc', 'libkern', 'arm', 'i386', 'machine', 'net', 'netinet', 'arpa']);
    const frameworks = new Set(['Foundation']);
    for (const [, fw] of src.matchAll(/#(?:import|include)\s*<(\w+)\//g)) {
      if (!notFrameworks.has(fw)) frameworks.add(fw);
    }
    for (const fw of frameworks) cmd.push('-framework', fw);
  }

  try {
    execSync(cmd.join(' '), { stdio: 'pipe', encoding: 'utf8' });
  } catch (err) {
    console.error(`[ferrum] Component dylib compile failed: ${path.basename(filepath)}`);
    console.error((err.stderr || '').slice(0, 1000));
    return null;
  }

  if (_signingIdentity) {
    try {
      execSync(`codesign -fs "${_signingIdentity}" "${dylibPath}"`, { stdio: 'pipe' });
    } catch {}
  }

  const size = fs.statSync(dylibPath).size;
  console.log(`[ferrum] Built ferrum_${baseName}.dylib component (${(size / 1024).toFixed(1)}KB)`);
  return dylibPath;
}

module.exports = { compileDylib, compileCppComponentDylib, generateBridge };
