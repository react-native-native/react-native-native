/**
 * Compiles a .swift file to a signed arm64 iOS dylib.
 * Same pattern as dylib-compiler.js for C++ and rust-compiler.js for Rust.
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

let _sdkPaths = {};
let _signingIdentity = null;
let _resolved = false;

function getSdkPath(target) {
  if (_sdkPaths[target]) return _sdkPaths[target];
  const sdk = target === 'simulator' ? 'iphonesimulator' : 'iphoneos';
  try {
    _sdkPaths[target] = execSync(`xcrun --sdk ${sdk} --show-sdk-path`, {
      encoding: 'utf8',
    }).trim();
  } catch {}
  return _sdkPaths[target] || null;
}

function resolveOnce(projectRoot) {
  if (_resolved) return;
  _resolved = true;

  try {
    let appTeamId = null;
    try {
      const appJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'app.json'), 'utf8'));
      appTeamId = appJson?.expo?.ios?.appleTeamId || null;
    } catch {}

    if (!appTeamId) {
      try {
        const pbx = execSync(
          `find "${projectRoot}/ios" -name "project.pbxproj" -maxdepth 3 2>/dev/null`,
          { encoding: 'utf8' }
        ).trim().split('\n')[0];
        if (pbx) {
          const m = fs.readFileSync(pbx, 'utf8').match(/DEVELOPMENT_TEAM\s*=\s*(\w+)/);
          if (m) appTeamId = m[1];
        }
      } catch {}
    }

    if (appTeamId) {
      const identities = execSync('security find-identity -v -p codesigning', {
        encoding: 'utf8',
      });
      const entries = [...identities.matchAll(/([A-F0-9]{40})\s+"([^"]+)"/g)];
      for (const [, , name] of entries) {
        try {
          const subject = execSync(
            `security find-certificate -c "${name}" -p 2>/dev/null | openssl x509 -noout -subject 2>/dev/null`,
            { encoding: 'utf8' }
          );
          if (subject.includes(`OU=${appTeamId}`)) {
            _signingIdentity = name;
            break;
          }
        } catch {}
      }
    }
  } catch {}
}

/**
 * Extract Swift function exports: @_cdecl functions with rna_ prefix.
 */
function extractSwiftExports(filepath) {
  let src;
  try { src = fs.readFileSync(filepath, 'utf8'); } catch { return []; }

  const moduleId = path.basename(filepath, '.swift').toLowerCase();
  const exports = [];

  // Match: // @rna_export or // @rna_export(sync) or // @rna_export(sync, main)
  const pattern = /\/\/\s*@?rna_export(?:\s*\(\s*([^)]*)\s*\))?\s*\n\s*(?:@_cdecl\s*\([^)]*\)\s*\n\s*)?func\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*(\S+))?\s*\{/g;
  let match;
  while ((match = pattern.exec(src)) !== null) {
    const [, modeStr, name, argsStr, retType] = match;
    const flags = (modeStr || '').split(',').map(s => s.trim());
    const cdeclName = `rna_swift_${moduleId}_${name}`;

    // Parse args (skip _ labels and UnsafePointer types from old-style exports)
    const args = argsStr.trim()
      ? argsStr.split(',').map(a => {
          const m = a.trim().match(/(?:\w+\s+)?(\w+)\s*:\s*(.+)/);
          return m ? { name: m[1], type: m[2].trim() } : null;
        }).filter(Boolean).filter(a => !a.type.includes('UnsafePointer'))
      : [];

    exports.push({
      name,
      async: flags.includes('async'),
      mainThread: flags.includes('main'),
      cdeclName,
      args,
      ret: retType || 'Void',
    });
  }

  return exports;
}

function compileSwiftDylib(filepath, projectRoot, { target = 'device' } = {}) {
  resolveOnce(projectRoot);
  const sdkPath = getSdkPath(target);
  if (!sdkPath) return null;

  const targetTriple = target === 'simulator'
    ? 'arm64-apple-ios15.1-simulator'
    : 'arm64-apple-ios15.1';

  const name = path.basename(filepath, '.swift');
  const moduleId = name.toLowerCase();
  const outputDir = path.join(projectRoot, '.ferrum/dylibs', target);
  fs.mkdirSync(outputDir, { recursive: true });
  const _isComp = (() => {
    try { return fs.readFileSync(filepath, 'utf8').includes('@rna_component'); } catch { return false; }
  })();
  const dylibName = _isComp ? `ferrum_${moduleId}` : moduleId;
  const dylibPath = path.join(outputDir, `${dylibName}.dylib`);

  // Generate Swift bridge with @_cdecl wrappers + C registration file
  const exports = extractSwiftExports(filepath);

  // Check if this is a component (has @rna_component or ferrum::component)
  const userSrc = fs.readFileSync(filepath, 'utf8');
  const isComponent = userSrc.includes('@rna_component') || userSrc.includes('ferrum::component');

  if (isComponent) {
    // Component: needs ferrum_register_render, not rna_register_sync
    const cBridgePath = path.join(outputDir, `${moduleId}_reg.c`);
    fs.writeFileSync(cBridgePath, `
typedef void (*FerrumRenderFn)(void*, float, float, void*, void*);
extern void ferrum_register_render(const char*, FerrumRenderFn);
extern void ferrum_${moduleId}_render(void*, float, float, void*, void*);

__attribute__((constructor))
void rna_register_${moduleId}(void) {
  ferrum_register_render("ferrum.${moduleId}", ferrum_${moduleId}_render);
}
`);

    const cmd = [
      'swiftc',
      '-emit-library',
      '-target', targetTriple,
      '-sdk', sdkPath,
      '-Xlinker', '-undefined',
      '-Xlinker', 'dynamic_lookup',
      '-o', dylibPath,
      filepath,
      cBridgePath,
    ];

    console.log(`[ferrum] Compiling ${name}.swift component via swiftc...`);
    try {
      execSync(cmd.join(' '), { stdio: 'pipe', encoding: 'utf8' });
    } catch (err) {
      console.error(`[ferrum] Swift compile failed: ${name}.swift`);
      console.error((err.stderr || '').slice(0, 2000));
      return null;
    }

    if (_signingIdentity) {
      try { execSync(`codesign -fs "${_signingIdentity}" "${dylibPath}"`, { stdio: 'pipe' }); } catch {}
    }

    const size = fs.statSync(dylibPath).size;
    console.log(`[ferrum] Built ${moduleId}.dylib component (${(size / 1024).toFixed(1)}KB)`);
    return { dylibPath, exports: [], isComponent: true };
  }

  // Function exports: generate Swift + C bridges
  const swiftBridgePath = path.join(outputDir, `${moduleId}_bridge.swift`);
  let swiftWrappers = 'import Foundation\n';
  swiftWrappers += exports.map(fn => {
    const retType = fn.ret || 'Void';
    const argPassthrough = fn.args.map(a => a.name).join(', ');

    let resultExpr;
    if (retType === 'String') {
      resultExpr = `UnsafePointer(strdup("\\"" + result + "\\"")!)`;
    } else if (retType === 'Bool') {
      resultExpr = `UnsafePointer(strdup(result ? "true" : "false")!)`;
    } else if (retType === 'Void') {
      resultExpr = `UnsafePointer(strdup("null")!)`;
    } else {
      resultExpr = `UnsafePointer(strdup(String(result))!)`;
    }

    if (fn.mainThread) {
      return `
@_cdecl("${fn.cdeclName}")
func _rna_${fn.name}(_ argsJson: UnsafePointer<CChar>) -> UnsafePointer<CChar> {
    var ptr: UnsafePointer<CChar>!
    DispatchQueue.main.sync {
        let result = ${fn.name}(${argPassthrough})
        ptr = ${resultExpr}
    }
    return ptr
}`;
    }

    return `
@_cdecl("${fn.cdeclName}")
func _rna_${fn.name}(_ argsJson: UnsafePointer<CChar>) -> UnsafePointer<CChar> {
    let result = ${fn.name}(${argPassthrough})
    return ${resultExpr}
}`;
  }).join('\n');

  fs.writeFileSync(swiftBridgePath, swiftWrappers.toString());

  // C registration file
  const cBridgePath = path.join(outputDir, `${moduleId}_reg.c`);
  const registrations = exports.map(fn =>
    `  rna_register_sync("${moduleId}", "${fn.name}", ${fn.cdeclName});`
  ).join('\n');
  const declarations = exports.map(fn =>
    `extern const char* ${fn.cdeclName}(const char*);`
  ).join('\n');

  fs.writeFileSync(cBridgePath, `
typedef const char* (*RNASyncFn)(const char*);
extern void rna_register_sync(const char*, const char*, RNASyncFn);
${declarations}

__attribute__((constructor))
void rna_register_${moduleId}(void) {
${registrations}
}
`);

  const cmd = [
    'swiftc',
    '-emit-library',
    '-target', targetTriple,
    '-sdk', sdkPath,
    '-Xlinker', '-undefined',
    '-Xlinker', 'dynamic_lookup',
    '-o', dylibPath,
    filepath,
    swiftBridgePath,
    cBridgePath,
  ];

  console.log(`[ferrum] Compiling ${name}.swift via swiftc...`);
  try {
    execSync(cmd.join(' '), { stdio: 'pipe', encoding: 'utf8' });
  } catch (err) {
    console.error(`[ferrum] Swift compile failed: ${name}.swift`);
    console.error((err.stderr || '').slice(0, 2000));
    return null;
  }

  // Sign
  if (_signingIdentity) {
    try {
      execSync(`codesign -fs "${_signingIdentity}" "${dylibPath}"`, { stdio: 'pipe' });
    } catch {}
  }

  const size = fs.statSync(dylibPath).size;
  console.log(`[ferrum] Built ${moduleId}.dylib (${(size / 1024).toFixed(1)}KB)`);
  return { dylibPath, exports };
}

module.exports = { compileSwiftDylib, extractSwiftExports };
