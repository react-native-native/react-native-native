/**
 * React Native Native — Expo config plugin.
 *
 * Creates a CocoaPods pod for user native code with three fixed-name files:
 *   - bridges/nativ_bridges.mm   — all C++/ObjC++ bridges + Swift/Rust registration
 *   - bridges/nativ_bridges.swift — all Swift source + @_cdecl wrappers
 *   - bridges/libnativ_user.a    — unified Rust static library
 *
 * Stubs are created at prebuild time (so pod install picks them up).
 * A :before_compile script phase regenerates them with real content on Release builds.
 * Debug builds skip the script — all native code loads via Metro dylibs.
 */

const { withDangerousMod, withXcodeProject } = require('@expo/config-plugins');
const path = require('path');
const fs = require('fs');

function withReactNativeNative(config) {
  config = withNativPod(config);
  config = withPodfileEntry(config);
  config = withForceLoad(config);
  return config;
}

// ─── Generate .nativ/ with podspec + stub bridge files ──────────────────

function withNativPod(config) {
  return withDangerousMod(config, ['ios', (config) => {
    const projectRoot = config.modRequest.projectRoot;
    const pkgDir = path.join(projectRoot, '.nativ');
    const bridgesDir = path.join(pkgDir, 'bridges');
    fs.mkdirSync(bridgesDir, { recursive: true });

    // Resolve paths relative to .nativ/ for the podspec
    const nativFabricDir = path.resolve(__dirname);
    const relCompiler = path.relative(pkgDir, path.join(nativFabricDir, 'metro/compilers/static-compiler.js'));
    const relMetroDir = path.relative(pkgDir, path.join(nativFabricDir, 'metro'));

    // ── Stub source files (valid code that compiles to nothing) ──
    fs.writeFileSync(path.join(bridgesDir, 'nativ_bridges.mm'),
      '// Stub — real bridges generated at Release build time by React Native Native\n');
    fs.writeFileSync(path.join(bridgesDir, 'nativ_bridges.swift'),
      '// Stub — real bridges generated at Release build time by React Native Native\nimport Foundation\n');
    // Empty ar archive (valid .a that links to nothing)
    fs.writeFileSync(path.join(bridgesDir, 'libnativ_user.a'), '!<arch>\n');

    // ── Build script (called by CocoaPods script phase) ──
    fs.writeFileSync(path.join(pkgDir, 'build-bridges.sh'),
`#!/bin/bash
set -euo pipefail

if [ "\${CONFIGURATION}" = "Debug" ]; then
  echo "[nativ] Debug build — skipping static compilation"
  exit 0
fi

echo "[nativ] Building native bridges for Release..."
node "$PODS_TARGET_SRCROOT/${relCompiler}" \\
  --platform ios \\
  --root "$PODS_TARGET_SRCROOT/.." \\
  --output "$PODS_TARGET_SRCROOT/bridges"
`);
    fs.chmodSync(path.join(pkgDir, 'build-bridges.sh'), 0o755);

    // ── Podspec ──
    fs.writeFileSync(path.join(pkgDir, 'ReactNativeNativeUserCode.podspec'),
`Pod::Spec.new do |s|
  s.name           = 'ReactNativeNativeUserCode'
  s.version        = '0.1.0'
  s.summary        = 'User native code — React Native Native'
  s.homepage       = 'https://react-native-native.dev'
  s.license        = { :type => 'MIT' }
  s.author         = 'Generated'
  s.source         = { :git => '' }
  s.platforms      = { :ios => '15.1' }
  s.static_framework = true

  s.source_files       = ['bridges/nativ_bridges.mm', 'bridges/nativ_bridges.swift']
  s.vendored_libraries = ['bridges/libnativ_user.a']
  s.preserve_paths     = ['bridges/*']

  s.dependency 'NativFabric'

  s.pod_target_xcconfig = {
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
    'HEADER_SEARCH_PATHS' => '"$(PODS_TARGET_SRCROOT)/${relMetroDir}"',
    'OTHER_LDFLAGS' => '$(inherited) -lc++',
  }

  s.script_phase = {
    :name => 'Build Native Bridges',
    :script => 'bash "$PODS_TARGET_SRCROOT/build-bridges.sh"',
    :execution_position => :before_compile,
  }
end
`);

    return config;
  }]);
}

// ─── Add pod to Podfile ─────────────────────────────────────────────────

function withPodfileEntry(config) {
  return withDangerousMod(config, ['ios', (config) => {
    const projectRoot = config.modRequest.projectRoot;
    const podfilePath = path.join(projectRoot, 'ios', 'Podfile');

    if (!fs.existsSync(podfilePath)) return config;

    let podfile = fs.readFileSync(podfilePath, 'utf8');
    const podLine = "  pod 'ReactNativeNativeUserCode', :path => File.join(__dir__, '..', '.nativ')";

    if (!podfile.includes('ReactNativeNativeUserCode')) {
      // Insert after use_expo_modules! (standard Expo Podfile location)
      const insertIdx = podfile.indexOf('use_expo_modules!');
      if (insertIdx !== -1) {
        const lineEnd = podfile.indexOf('\n', insertIdx);
        podfile = podfile.slice(0, lineEnd + 1) + podLine + '\n' + podfile.slice(lineEnd + 1);
      } else {
        // Fallback: insert before the last 'end' in the target block
        const lastEnd = podfile.lastIndexOf('\nend');
        if (lastEnd !== -1) {
          podfile = podfile.slice(0, lastEnd) + '\n' + podLine + podfile.slice(lastEnd);
        }
      }
      fs.writeFileSync(podfilePath, podfile);
    }

    return config;
  }]);
}

// ─── Force-load constructors from static libraries in Release ───────────

function withForceLoad(config) {
  return withXcodeProject(config, (config) => {
    const xcodeProject = config.modResults;
    const buildSettings = xcodeProject.pbxXCBuildConfigurationSection();

    for (const key of Object.keys(buildSettings)) {
      const cfg = buildSettings[key];
      if (typeof cfg === 'object' && cfg.name === 'Release' && cfg.buildSettings) {
        const flags = cfg.buildSettings.OTHER_LDFLAGS || ['$(inherited)'];
        if (!flags.includes('-all_load')) {
          if (typeof flags === 'string') {
            cfg.buildSettings.OTHER_LDFLAGS = [flags, '-all_load'];
          } else {
            flags.push('-all_load');
          }
        }
      }
    }

    return config;
  });
}

module.exports = withReactNativeNative;
