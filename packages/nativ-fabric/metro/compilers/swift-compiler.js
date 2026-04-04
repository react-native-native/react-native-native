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
 * Extract Swift function exports: @_cdecl functions with nativ_ prefix.
 */
function extractSwiftExports(filepath) {
  let src;
  try { src = fs.readFileSync(filepath, 'utf8'); } catch { return []; }

  const moduleId = path.basename(filepath, '.swift').toLowerCase();
  const exports = [];

  // Match: // @nativ_export or // @nativ_export(sync) or // @nativ_export(sync, main)
  const pattern = /\/\/\s*@?nativ_export(?:\s*\(\s*([^)]*)\s*\))?\s*\n\s*(?:@_cdecl\s*\([^)]*\)\s*\n\s*)?func\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*(\S+))?\s*\{/g;
  let match;
  while ((match = pattern.exec(src)) !== null) {
    const [, modeStr, name, argsStr, retType] = match;
    const flags = (modeStr || '').split(',').map(s => s.trim());
    const cdeclName = `nativ_swift_${moduleId}_${name}`;

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
  const outputDir = path.join(projectRoot, '.nativ/dylibs', target);
  fs.mkdirSync(outputDir, { recursive: true });
  const _isComp = (() => {
    try { return fs.readFileSync(filepath, 'utf8').includes('@nativ_component'); } catch { return false; }
  })();
  const dylibName = _isComp ? `nativ_${moduleId}` : moduleId;
  const dylibPath = path.join(outputDir, `${dylibName}.dylib`);

  // Generate Swift bridge with @_cdecl wrappers + C registration file
  const exports = extractSwiftExports(filepath);

  // Check if this is a component (has @nativ_component or nativ::component)
  const userSrc = fs.readFileSync(filepath, 'utf8');
  const isComponent = userSrc.includes('@nativ_component') || userSrc.includes('nativ::component');

  if (isComponent) {
    // Parse the SwiftUI View struct to extract props
    const structMatch = userSrc.match(/\/\/\s*@nativ_component\s*\n\s*struct\s+(\w+)\s*:\s*View\s*\{([\s\S]*?)var\s+body\s*:\s*some\s+View/);
    const structName = structMatch ? structMatch[1] : name;
    const propsBlock = structMatch ? structMatch[2] : '';

    // Parse fields: let title: String, let count: Int, var opacity: Double = 1.0
    const props = [];
    for (const line of propsBlock.split('\n')) {
      const m = line.trim().match(/(?:let|var)\s+(\w+)\s*:\s*(\w+)/);
      if (m) {
        const [, propName, propType] = m;
        if (!['body'].includes(propName)) {
          props.push({ name: propName, type: propType });
        }
      }
    }

    // Generate Swift bridge file with render function + JSI prop extraction
    const swiftBridgePath = path.join(outputDir, `${moduleId}_bridge.swift`);
    const renderFnName = `nativ_${moduleId}_render`;

    const propExtractions = props.map(p => {
      if (p.type === 'String') {
        return `    let ${p.name} = String(cString: nativ_jsi_get_string(runtime, props, "${p.name}"))`;
      } else if (p.type === 'Double' || p.type === 'Float' || p.type === 'CGFloat') {
        return `    let ${p.name} = ${p.type}(nativ_jsi_get_number(runtime, props, "${p.name}"))`;
      } else if (p.type === 'Int') {
        return `    let ${p.name} = Int(nativ_jsi_get_number(runtime, props, "${p.name}"))`;
      } else if (p.type === 'Bool') {
        return `    let ${p.name} = nativ_jsi_has_prop(runtime, props, "${p.name}") != 0 && nativ_jsi_get_number(runtime, props, "${p.name}") != 0`;
      } else if (p.type === 'Color') {
        return `    let ${p.name}: Color = {
        let hex = String(cString: nativ_jsi_get_string(runtime, props, "${p.name}"))
        let scanner = Scanner(string: hex.hasPrefix("#") ? String(hex.dropFirst()) : hex)
        var rgb: UInt64 = 0; scanner.scanHexInt64(&rgb)
        return Color(red: Double((rgb >> 16) & 0xFF) / 255, green: Double((rgb >> 8) & 0xFF) / 255, blue: Double(rgb & 0xFF) / 255)
    }()`;
      } else {
        return `    // TODO: unsupported prop type ${p.type} for ${p.name}`;
      }
    });

    // Build the struct initializer args
    const initArgs = props.map(p => {
      if (p.type === 'Color') {
        return `${p.name}: Color(red: nativ_jsi_get_number(runtime, props, "r"), green: nativ_jsi_get_number(runtime, props, "g"), blue: nativ_jsi_get_number(runtime, props, "b"))`;
      }
      return `${p.name}: ${p.name}`;
    }).join(', ');

    const bridgeSwift = `import SwiftUI
import UIKit

// Auto-generated bridge for ${structName}

@_cdecl("${renderFnName}")
func ${renderFnName}(
    _ view: UnsafeMutableRawPointer,
    _ width: Float, _ height: Float,
    _ runtime: UnsafeMutableRawPointer?,
    _ props: UnsafeMutableRawPointer?
) {
    let parentView = Unmanaged<UIView>.fromOpaque(view).takeUnretainedValue()

    // Extract props via JSI C API
${propExtractions.join('\n')}

    let swiftUIView = ${structName}(${initArgs})
    let hostingController = UIHostingController(rootView: swiftUIView)
    hostingController.view.frame = CGRect(x: 0, y: 0, width: CGFloat(width), height: CGFloat(height))
    hostingController.view.backgroundColor = .clear

    objc_setAssociatedObject(parentView, "nativHosting", hostingController, .OBJC_ASSOCIATION_RETAIN)
    parentView.addSubview(hostingController.view)
}

// JSI C API — resolved at dlopen time via -undefined dynamic_lookup
@_silgen_name("nativ_jsi_get_string")
func nativ_jsi_get_string(_ rt: UnsafeMutableRawPointer?, _ obj: UnsafeMutableRawPointer?, _ name: UnsafePointer<CChar>) -> UnsafePointer<CChar>

@_silgen_name("nativ_jsi_get_number")
func nativ_jsi_get_number(_ rt: UnsafeMutableRawPointer?, _ obj: UnsafeMutableRawPointer?, _ name: UnsafePointer<CChar>) -> Double

@_silgen_name("nativ_jsi_has_prop")
func nativ_jsi_has_prop(_ rt: UnsafeMutableRawPointer?, _ obj: UnsafeMutableRawPointer?, _ name: UnsafePointer<CChar>) -> Int32
`;
    fs.writeFileSync(swiftBridgePath, bridgeSwift);

    // C registration file
    const cBridgePath = path.join(outputDir, `${moduleId}_reg.c`);
    fs.writeFileSync(cBridgePath, `
typedef void (*NativRenderFn)(void*, float, float, void*, void*);
extern void nativ_register_render(const char*, NativRenderFn);
extern void ${renderFnName}(void*, float, float, void*, void*);

__attribute__((constructor))
void nativ_register_${moduleId}(void) {
  nativ_register_render("nativ.${moduleId}", ${renderFnName});
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

    console.log(`[nativ] Compiling ${name}.swift component via swiftc...`);
    try {
      execSync(cmd.join(' '), { stdio: 'pipe', encoding: 'utf8' });
    } catch (err) {
      console.error(`[nativ] Swift compile failed: ${name}.swift`);
      console.error((err.stderr || '').slice(0, 2000));
      return null;
    }

    if (_signingIdentity) {
      try { execSync(`codesign -fs "${_signingIdentity}" "${dylibPath}"`, { stdio: 'pipe' }); } catch {}
    }

    const size = fs.statSync(dylibPath).size;
    console.log(`[nativ] Built ${moduleId}.dylib component (${(size / 1024).toFixed(1)}KB)`);
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
func _nativ_${fn.name}(_ argsJson: UnsafePointer<CChar>) -> UnsafePointer<CChar> {
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
func _nativ_${fn.name}(_ argsJson: UnsafePointer<CChar>) -> UnsafePointer<CChar> {
    let result = ${fn.name}(${argPassthrough})
    return ${resultExpr}
}`;
  }).join('\n');

  fs.writeFileSync(swiftBridgePath, swiftWrappers.toString());

  // C registration file
  const cBridgePath = path.join(outputDir, `${moduleId}_reg.c`);
  const registrations = exports.map(fn =>
    `  nativ_register_sync("${moduleId}", "${fn.name}", ${fn.cdeclName});`
  ).join('\n');
  const declarations = exports.map(fn =>
    `extern const char* ${fn.cdeclName}(const char*);`
  ).join('\n');

  fs.writeFileSync(cBridgePath, `
typedef const char* (*NativSyncFn)(const char*);
extern void nativ_register_sync(const char*, const char*, NativSyncFn);
${declarations}

__attribute__((constructor))
void nativ_register_${moduleId}(void) {
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

  console.log(`[nativ] Compiling ${name}.swift via swiftc...`);
  try {
    execSync(cmd.join(' '), { stdio: 'pipe', encoding: 'utf8' });
  } catch (err) {
    console.error(`[nativ] Swift compile failed: ${name}.swift`);
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
  console.log(`[nativ] Built ${moduleId}.dylib (${(size / 1024).toFixed(1)}KB)`);
  return { dylibPath, exports };
}

// ─── Android: Swift → .so via swift build ──────────────────────────────

let _swiftAndroidAvailable = null;

function isSwiftAndroidAvailable() {
  if (_swiftAndroidAvailable !== null) return _swiftAndroidAvailable;
  try {
    // Try swiftly (6.3+) first, fall back to system swift
    let sdks = '';
    try { sdks = execSync('swiftly run +6.3 swift sdk list 2>/dev/null', { encoding: 'utf8', timeout: 10000 }); }
    catch { sdks = execSync('swift sdk list 2>/dev/null', { encoding: 'utf8', timeout: 5000 }); }
    _swiftAndroidAvailable = sdks.includes('android');
  } catch {
    _swiftAndroidAvailable = false;
  }
  if (!_swiftAndroidAvailable) {
    console.log('[nativ] Swift Android SDK not installed — .swift files are iOS-only');
  }
  return _swiftAndroidAvailable;
}

const ANDROID_SWIFT_TARGETS = {
  'arm64-v8a': 'aarch64-unknown-linux-android28',
  'armeabi-v7a': 'armv7-unknown-linux-android28',
  'x86_64': 'x86_64-unknown-linux-android28',
};

function compileSwiftAndroidSo(filepath, projectRoot, { target = 'arm64-v8a' } = {}) {
  if (!isSwiftAndroidAvailable()) return null;

  const swiftTarget = ANDROID_SWIFT_TARGETS[target];
  if (!swiftTarget) return null;

  const name = path.basename(filepath, '.swift');
  const moduleId = name.toLowerCase();
  const userSrc = fs.readFileSync(filepath, 'utf8');

  // SwiftUI components are iOS-only — no UIKit/SwiftUI on Android
  if (userSrc.includes('@nativ_component') || userSrc.includes('nativ::component')) {
    return null;
  }

  const exports = extractSwiftExports(filepath);
  if (exports.length === 0) return null;

  // Build in a per-module directory
  const buildDir = path.join(projectRoot, '.nativ/swift-android', moduleId);
  const swiftSrcDir = path.join(buildDir, 'Sources', moduleId);
  fs.mkdirSync(swiftSrcDir, { recursive: true });

  // Copy user source
  fs.copyFileSync(filepath, path.join(swiftSrcDir, path.basename(filepath)));

  // Generate @_cdecl wrappers with JSON arg parsing (no Foundation dependency)
  let swiftWrappers = '#if canImport(Android)\nimport Android\n#elseif canImport(Glibc)\nimport Glibc\n#endif\n';

  // JSON array parser — works at byte level via C pointer, no Swift String gymnastics
  swiftWrappers += `
private func _parseArgs(_ json: UnsafePointer<CChar>) -> [String] {
    var p = json
    // skip to [
    while p.pointee != 0 && p.pointee != 0x5B { p += 1 } // 0x5B = '['
    if p.pointee == 0 { return [] }
    p += 1 // skip [

    var result: [String] = []
    var buf: [UInt8] = []
    var inStr = false
    var esc = false

    while p.pointee != 0 {
        let c = UInt8(bitPattern: p.pointee)
        if esc { buf.append(c); esc = false; p += 1; continue }
        if c == 0x5C { esc = true; p += 1; continue }  // backslash
        if c == 0x22 { inStr = !inStr; p += 1; continue }  // quote
        if c == 0x5D && !inStr { break }  // ]
        if c == 0x2C && !inStr {  // comma
            result.append(String(decoding: buf, as: UTF8.self))
            buf = []
            p += 1
            continue
        }
        if c != 0x20 || inStr { buf.append(c) }  // skip spaces outside strings
        p += 1
    }
    if !buf.isEmpty { result.append(String(decoding: buf, as: UTF8.self)) }
    return result
}
`;

  swiftWrappers += exports.map(fn => {
    const retType = fn.ret || 'Void';

    // Generate arg parsing + labeled call
    const argParsing = fn.args.length > 0
      ? '    let args = _parseArgs(argsJson)\n'
      : '';
    const argExprs = fn.args.map((a, i) => {
      const t = a.type.trim();
      const safe = `(args.count > ${i} ? args[${i}] : "")`;
      if (t === 'Int') return `${a.name}: Int(${safe}) ?? 0`;
      if (t === 'Double' || t === 'Float') return `${a.name}: ${t}(${safe}) ?? 0`;
      if (t === 'Bool') return `${a.name}: ${safe} == "true"`;
      return `${a.name}: ${safe}`;  // String
    });
    const call = `${fn.name}(${argExprs.join(', ')})`;

    let resultExpr;
    if (retType === 'String') resultExpr = `UnsafePointer(strdup("\\"" + result + "\\"")!)`;
    else if (retType === 'Bool') resultExpr = `UnsafePointer(strdup(result ? "true" : "false")!)`;
    else if (retType === 'Void') resultExpr = `UnsafePointer(strdup("null")!)`;
    else resultExpr = `UnsafePointer(strdup(String(result))!)`;

    return `
@_cdecl("${fn.cdeclName}")
public func _nativ_${fn.name}(_ argsJson: UnsafePointer<CChar>) -> UnsafePointer<CChar> {
${argParsing}    let result = ${call}
    return ${resultExpr}
}`;
  }).join('\n');
  fs.writeFileSync(path.join(swiftSrcDir, `${moduleId}_bridge.swift`), swiftWrappers);

  // Generate C init file — compiled separately by clang (not SPM)
  const regCalls = exports
    .filter(fn => !fn.async)
    .map(fn => `  if (reg) reg("${moduleId}", "${fn.name}", ${fn.cdeclName});`)
    .join('\n');
  const declarations = exports
    .filter(fn => !fn.async)
    .map(fn => `extern const char* ${fn.cdeclName}(const char*);`)
    .join('\n');

  const initCPath = path.join(buildDir, 'nativ_init.c');
  fs.writeFileSync(initCPath, `
#include <stddef.h>
typedef const char* (*NativSyncFn)(const char*);
typedef void (*NativRegFn)(const char*, const char*, NativSyncFn);

${declarations}

__attribute__((visibility("default")))
void nativ_init(void* reg_fn) {
  NativRegFn reg = (NativRegFn)reg_fn;
${regCalls}
}
`);

  // Package.swift — Swift-only static library (no C target needed)
  fs.writeFileSync(path.join(buildDir, 'Package.swift'), `// swift-tools-version: 6.2
import PackageDescription
let package = Package(
    name: "${moduleId}",
    products: [
        .library(name: "${moduleId}", type: .static, targets: ["${moduleId}"])
    ],
    targets: [
        .target(name: "${moduleId}")
    ]
)
`);

  // Build
  console.log(`[nativ] Compiling ${name}.swift for Android (${target})...`);
  try {
    execSync(
      `swiftly run +6.3 swift build --swift-sdk ${swiftTarget} -Xswiftc -static-stdlib -Xcc -fvisibility=default -c release`,
      { cwd: buildDir, stdio: 'pipe', encoding: 'utf8', timeout: 120000 }
    );
  } catch (err) {
    console.error(`[nativ] Swift Android compile failed: ${name}.swift`);
    console.error((err.stderr || err.stdout || err.message || '').slice(0, 3000));
    return null;
  }

  // Find output .a (static lib from SPM)
  const aPath = path.join(buildDir, '.build', swiftTarget, 'release', `lib${moduleId}.a`);
  if (!fs.existsSync(aPath)) {
    console.error(`[nativ] Swift Android .a not found at ${aPath}`);
    return null;
  }

  // Re-link into a self-contained .so:
  // 1. Compile nativ_init.c with default visibility
  // 2. Link Swift .a + nativ_init.o + Swift static runtime → single .so
  const outputDir = path.join(projectRoot, '.nativ/dylibs', target);
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${moduleId}.so`);

  const abiToTriple = { 'arm64-v8a': 'aarch64-linux-android', 'armeabi-v7a': 'armv7a-linux-androideabi', 'x86_64': 'x86_64-linux-android' };
  const triple = abiToTriple[target] || 'aarch64-linux-android';
  const ndkHome = process.env.ANDROID_NDK_HOME || path.join(process.env.HOME || require('os').homedir(), 'Library/Android/sdk/ndk');
  const ndkVersions = fs.readdirSync(ndkHome).filter(d => /^\d/.test(d)).sort();
  const ndkDir = path.join(ndkHome, ndkVersions[ndkVersions.length - 1]);
  const clang = path.join(ndkDir, 'toolchains/llvm/prebuilt/darwin-x86_64/bin', `${triple}28-clang`);

  const swiftAbiMap = { 'arm64-v8a': 'aarch64', 'armeabi-v7a': 'armv7', 'x86_64': 'x86_64' };
  const swiftArch = swiftAbiMap[target] || 'aarch64';
  const swiftLibDir = path.join(
    process.env.HOME || require('os').homedir(),
    `Library/org.swift.swiftpm/swift-sdks/swift-6.3-RELEASE_android.artifactbundle/swift-android/swift-resources/usr/lib/swift_static-${swiftArch}/android`
  );

  try {
    // Compile nativ_init.c → .o (with default visibility)
    const initOPath = path.join(buildDir, 'nativ_init.o');
    execSync(
      `${clang} -c -fvisibility=default -o ${initOPath} ${initCPath}`,
      { stdio: 'pipe', encoding: 'utf8' }
    );

    // Link everything into one .so
    const linkCmd = [
      clang, '-shared', '-o', outputPath,
      '-Wl,--whole-archive', aPath, '-Wl,--no-whole-archive',
      initOPath,
      `-L${swiftLibDir}`,
      `@${swiftLibDir}/static-stdlib-args.lnk`,
      '-lm', '-ldl', '-llog',
    ].join(' ');
    execSync(linkCmd, { stdio: 'pipe', encoding: 'utf8' });
  } catch (err) {
    console.error(`[nativ] Swift Android link failed: ${name}.swift`);
    console.error((err.stderr || err.message || '').slice(0, 2000));
    return null;
  }

  const size = fs.statSync(outputPath).size;
  console.log(`[nativ] Built ${moduleId}.so (${(size / 1024).toFixed(1)}KB)`);
  return { dylibPath: outputPath, exports };
}

module.exports = { compileSwiftDylib, compileSwiftAndroidSo, extractSwiftExports, isSwiftAndroidAvailable };
