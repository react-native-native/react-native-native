#!/usr/bin/env node

/**
 * doctor.js — Scans development environment for React Native Native prerequisites.
 *
 * Checks are language-aware: only shows Rust checks if Cargo.toml exists,
 * Kotlin if .kt files exist, Compose if @Composable is used, etc.
 *
 * Run: npx nativ doctor
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const projectRoot = process.cwd();
const platformArg = process.argv.find((a, i) => i > 0 && process.argv[i - 1] === '--platform') || 'all';
const wantIOS = platformArg === 'all' || platformArg === 'ios';
const wantAndroid = platformArg === 'all' || platformArg === 'android';
let issues = 0;

// ── Helpers ───────────────────────────────────────────────────────────

function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: 'pipe', timeout: 5000 }).trim();
  } catch { return null; }
}

function ok(msg) { console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
function fail(msg, fix) { issues++; console.log(`  \x1b[31m✗\x1b[0m ${msg}`); if (fix) console.log(`      ${fix}`); }
function skip(msg) { console.log(`  \x1b[90m○\x1b[0m ${msg}`); }
function header(title) { console.log(`\n\x1b[1m${title}:\x1b[0m`); }

function findFiles(exts) {
  const results = [];
  const ignore = ['node_modules', '.nativ', 'ios', 'android', 'vendor', '.git'];
  function walk(dir, depth) {
    if (depth > 3) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (ignore.includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (exts.some(ext => entry.name.endsWith(ext))) results.push(full);
    }
  }
  walk(projectRoot, 0);
  return results;
}

// ── Detect opted-in languages ─────────────────────────────────────────

const hasCargoToml = fs.existsSync(path.join(projectRoot, 'Cargo.toml'));
const rsFiles = findFiles(['.rs']);
const ktFiles = findFiles(['.kt']);
const cppFiles = findFiles(['.cpp', '.cc', '.mm']);
const swiftFiles = findFiles(['.swift']);
const hasCompose = ktFiles.some(f => {
  try { return fs.readFileSync(f, 'utf8').includes('@Composable'); } catch { return false; }
});

// ── Environment ───────────────────────────────────────────────────────

console.log('\n\x1b[1mreact-native-native doctor\x1b[0m');
console.log('───────────────────────────────────────────');

header('Environment');

const nodeVersion = run('node --version');
if (nodeVersion) ok(`Node.js ${nodeVersion}`);
else fail('Node.js not found');

// React Native version
try {
  const rnPkg = JSON.parse(fs.readFileSync(
    require.resolve('react-native/package.json', { paths: [projectRoot] }), 'utf8'));
  ok(`react-native ${rnPkg.version}`);
} catch { skip('react-native not found in node_modules'); }

// nativ-fabric version
try {
  const nfPkg = JSON.parse(fs.readFileSync(
    require.resolve('@react-native-native/nativ-fabric/package.json', { paths: [projectRoot] }), 'utf8'));
  ok(`@react-native-native/nativ-fabric ${nfPkg.version}`);
} catch { fail('@react-native-native/nativ-fabric not installed', 'Run: npm install @react-native-native/nativ-fabric'); }

// Config file
const configPath = path.join(projectRoot, '.nativ/nativ.config.json');
if (fs.existsSync(configPath)) {
  ok('.nativ/nativ.config.json found');
} else {
  skip('.nativ/nativ.config.json not found (created by setup commands)');
}

// .gitignore — .nativ/ should be ignored
{
  let gitignorePath = null;
  try {
    let dir = projectRoot;
    const gitRoot = run(`git -C "${projectRoot}" rev-parse --show-toplevel`);
    const stopAt = gitRoot || projectRoot;
    while (dir.length >= stopAt.length) {
      const candidate = path.join(dir, '.gitignore');
      if (fs.existsSync(candidate)) { gitignorePath = candidate; break; }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {}
  if (gitignorePath) {
    const content = fs.readFileSync(gitignorePath, 'utf8');
    if (content.includes('.nativ')) ok('.nativ/ in .gitignore');
    else fail('.nativ/ not in .gitignore', 'Run: npx nativ setup');
  } else {
    fail('No .gitignore found', 'Run: npx nativ setup');
  }
}

// tsconfig.json — rootDirs for .d.ts resolution
try {
  const tsconfigPath = path.join(projectRoot, 'tsconfig.json');
  if (fs.existsSync(tsconfigPath)) {
    const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf8'));
    const rootDirs = tsconfig.compilerOptions?.rootDirs || [];
    if (rootDirs.some(d => d.includes('.nativ/typings'))) ok('tsconfig rootDirs includes .nativ/typings');
    else fail('tsconfig missing rootDirs for .nativ/typings', 'Run: npx nativ setup');
  }
} catch {}

// ── C++ ───────────────────────────────────────────────────────────────

const mmFiles = cppFiles.filter(f => f.endsWith('.mm'));
const pureC = cppFiles.filter(f => !f.endsWith('.mm'));
header(wantIOS && mmFiles.length > 0 ? 'C++ / ObjC++' : 'C++');
if (cppFiles.length > 0) skip(`${cppFiles.length} file${cppFiles.length > 1 ? 's' : ''} found`);
else skip(wantIOS ? 'No .cpp/.mm files found' : 'No .cpp files found');
{
  if (wantIOS) {
    const clangVersion = run('clang++ --version');
    if (clangVersion) {
      const m = clangVersion.match(/Apple clang version ([\d.]+)/i) || clangVersion.match(/clang version ([\d.]+)/i);
      ok(`clang${m ? ' ' + m[1] : ''} (Xcode)`);
    } else {
      fail('clang++ not found', 'Install Xcode command line tools: xcode-select --install');
    }
  }
  if (wantAndroid) {
    const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
    if (androidHome) {
      const ndkDir = path.join(androidHome, 'ndk');
      try {
        const versions = fs.readdirSync(ndkDir).sort();
        if (versions.length > 0) {
          const toolchain = path.join(ndkDir, versions[versions.length - 1], 'toolchains/llvm/prebuilt');
          const hosts = fs.readdirSync(toolchain);
          if (hosts.length > 0) {
            const clangPath = path.join(toolchain, hosts[0], 'bin/aarch64-linux-android24-clang++');
            if (fs.existsSync(clangPath)) ok(`clang (NDK ${versions[versions.length - 1]})`);
            else fail('NDK clang++ not found');
          }
        }
      } catch {
        fail('NDK clang++ not found', 'Install Android NDK via SDK Manager');
      }
    } else if (pureC.length > 0) {
      fail('ANDROID_HOME not set — needed for C++ on Android');
    }
  }
}

// ── Swift (iOS only) ──────────────────────────────────────────────────

if (wantIOS) {
  header('Swift');
  if (swiftFiles.length > 0) skip(`${swiftFiles.length} file${swiftFiles.length > 1 ? 's' : ''} found`);
  else skip('No .swift files found');
  const swiftVersion = run('swiftc --version');
  if (swiftVersion) {
    const m = swiftVersion.match(/Swift version ([\d.]+)/);
    ok(`swiftc${m ? ' ' + m[1] : ''}`);
  } else {
    fail('swiftc not found', 'Install Xcode: xcode-select --install');
  }
}

// ── Rust ──────────────────────────────────────────────────────────────

header('Rust');
if (rsFiles.length > 0) skip(`${rsFiles.length} file${rsFiles.length > 1 ? 's' : ''} found`);
else skip('No .rs files found');

if (hasCargoToml) {
  ok('Cargo.toml found');
  try {
    const cargo = fs.readFileSync(path.join(projectRoot, 'Cargo.toml'), 'utf8');
    if (cargo.includes('nativ-core')) ok('nativ-core dependency');
    else fail('nativ-core not in Cargo.toml', 'Run: npx nativ setup rust');
  } catch {}
  if (fs.existsSync(path.join(projectRoot, '.nativ/lib.rs'))) ok('.nativ/lib.rs');
  else fail('.nativ/lib.rs missing', 'Run: npx nativ setup rust');
} else {
  skip('No Cargo.toml — run setup-rust to get started');
}

{
  const rustcVersion = run('rustc --version');
  if (rustcVersion) {
    const m = rustcVersion.match(/rustc ([\d.]+)/);
    ok(`rustc${m ? ' ' + m[1] : ''}`);
  } else {
    fail('rustc not found', 'Install: curl --proto \'=https\' --tlsv1.2 -sSf https://sh.rustup.rs | sh');
  }

  const installed = run('rustup target list --installed') || '';
  const targets = [
    ...(wantIOS ? [
      ['aarch64-apple-ios', 'iOS device'],
      ['aarch64-apple-ios-sim', 'iOS simulator'],
    ] : []),
    ...(wantAndroid ? [
      ['aarch64-linux-android', 'Android arm64'],
      ['armv7-linux-androideabi', 'Android armv7'],
      ['x86_64-linux-android', 'Android x86_64'],
    ] : []),
  ];
  let missingTargets = false;
  for (const [target, label] of targets) {
    if (installed.includes(target)) ok(`${target}`);
    else { fail(`${target} (${label})`); missingTargets = true; }
  }
  if (missingTargets) console.log(`      Run: npx nativ setup rust`);

  // NDK linker (needed for Android Rust cross-compilation)
  if (wantAndroid) {
    const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
    if (androidHome) {
      const ndkDir = path.join(androidHome, 'ndk');
      try {
        const versions = fs.readdirSync(ndkDir).sort();
        if (versions.length > 0) {
          const toolchain = path.join(ndkDir, versions[versions.length - 1], 'toolchains/llvm/prebuilt');
          const hosts = fs.readdirSync(toolchain);
          if (hosts.length > 0) {
            const linker = path.join(toolchain, hosts[0], 'bin/aarch64-linux-android24-clang');
            if (fs.existsSync(linker)) ok(`NDK linker (${versions[versions.length - 1]})`);
            else fail('NDK linker not found');
          }
        }
      } catch {
        fail('NDK not found', 'Install Android NDK via SDK Manager');
      }
    } else {
      fail('ANDROID_HOME not set', 'Needed for Rust Android cross-compilation');
    }
  }
}

// ── Kotlin + Compose (Android only) ───────────────────────────────────

if (wantAndroid) {
  header('Kotlin');
  if (ktFiles.length > 0) skip(`${ktFiles.length} file${ktFiles.length > 1 ? 's' : ''} found`);
  else skip('No .kt files found');

  let ktVersion = null;
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    ktVersion = config.kotlin?.version;
  } catch {}
  if (ktVersion) ok(`Kotlin version: ${ktVersion}`);
  else fail('Kotlin version not configured', 'Run: npx nativ setup kotlin');

  const gradleCache = path.join(process.env.HOME || '', '.gradle/caches/modules-2/files-2.1');
  const localCache = path.join(projectRoot, '.nativ/kotlin-cache');
  const checkJar = (group, artifact, label) => {
    const dir = path.join(gradleCache, group, artifact);
    try {
      const found = execSync(
        `find "${dir}" -name "*.jar" -not -name "*sources*" -not -name "*javadoc*" 2>/dev/null | head -1`,
        { encoding: 'utf8', stdio: 'pipe' }
      ).trim();
      if (found) { ok(label); return; }
    } catch {}
    try {
      const files = fs.readdirSync(localCache).filter(f => f.startsWith(artifact) && f.endsWith('.jar'));
      if (files.length > 0) { ok(`${label} (local cache)`); return; }
    } catch {}
    fail(`${label} not found`, 'Run: npx nativ setup kotlin');
  };
  checkJar('org.jetbrains.kotlin', 'kotlin-compiler-embeddable', 'kotlin-compiler-embeddable');
  checkJar('org.jetbrains.kotlin', 'kotlin-stdlib', 'kotlin-stdlib');

  const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
    || path.join(process.env.HOME || '', 'Library/Android/sdk');
  let hasAndroidJar = false;
  try {
    const platforms = path.join(androidHome, 'platforms');
    const versions = fs.readdirSync(platforms).sort();
    if (versions.length > 0) {
      const jar = path.join(platforms, versions[versions.length - 1], 'android.jar');
      if (fs.existsSync(jar)) { ok(`android.jar (${versions[versions.length - 1]})`); hasAndroidJar = true; }
    }
  } catch {}
  if (!hasAndroidJar) {
    if (fs.existsSync(path.join(localCache, 'android.jar'))) ok('android.jar (local cache)');
    else fail('android.jar not found', 'Run: npx nativ setup kotlin');
  }

  let hasD8 = false;
  try {
    const btDir = path.join(androidHome, 'build-tools');
    if (fs.existsSync(btDir) && fs.readdirSync(btDir).length > 0) { ok('d8 (build-tools)'); hasD8 = true; }
  } catch {}
  if (!hasD8) {
    if (fs.existsSync(path.join(localCache, 'd8.jar'))) ok('d8.jar (local cache)');
    else fail('d8 not found', 'Run: npx nativ setup kotlin');
  }

  // ── Jetpack Compose ─────────────────────────────────────────────────
  header('Jetpack Compose');
  if (hasCompose) skip('@Composable usage found');
  else skip('No @Composable files found');

  const pretransformDir = path.join(projectRoot, '.nativ/compose-pretransform');
  const checkComposeFile = (pattern, label) => {
    try {
      const files = fs.readdirSync(pretransformDir).filter(f => f.includes(pattern));
      if (files.length > 0) { ok(label); return; }
    } catch {}
    fail(label, 'Run: npx nativ setup compose');
  };
  checkComposeFile('compose-pretransform', 'compose-pretransform JAR');
  checkComposeFile('compose-wrappers', 'compose-wrappers JAR');
  checkComposeFile('compose-host', 'compose-host JAR');
  checkComposeFile('kotlin-compiler-', 'Non-embeddable Kotlin compiler');
}

// ── Android ───────────────────────────────────────────────────────────

// ── iOS ───────────────────────────────────────────────────────────────

if (wantIOS) {
  header('iOS');

  // Xcode
  const xcodeVersion = run('xcodebuild -version 2>/dev/null');
  if (xcodeVersion) {
    const m = xcodeVersion.match(/Xcode ([\d.]+)/);
    ok(`Xcode${m ? ' ' + m[1] : ''}`);
  } else {
    fail('Xcode not found', 'Install from the App Store');
  }

  // Team ID + signing identity
  let teamId = null;
  try {
    const appJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'app.json'), 'utf8'));
    teamId = appJson?.expo?.ios?.appleTeamId;
  } catch {}

  if (!teamId) {
    // Try pbxproj
    try {
      const pbx = run(`find "${projectRoot}/ios" -name "project.pbxproj" -maxdepth 3 2>/dev/null`);
      if (pbx) {
        const content = fs.readFileSync(pbx.split('\n')[0], 'utf8');
        const m = content.match(/DEVELOPMENT_TEAM\s*=\s*(\w+)/);
        if (m) teamId = m[1];
      }
    } catch {}
  }

  if (teamId) {
    ok(`Team ID: ${teamId} (from app.json)`);

    // Find matching signing identity
    const identities = run('security find-identity -v -p codesigning') || '';
    let foundIdentity = null;

    const entries = [...identities.matchAll(/([A-F0-9]{40})\s+"([^"]+)"/g)];
    for (const [, , name] of entries) {
      try {
        const subject = run(
          `security find-certificate -c "${name}" -p 2>/dev/null | openssl x509 -noout -subject 2>/dev/null`
        ) || '';
        if (subject.includes(`OU=${teamId}`)) {
          foundIdentity = name;
          break;
        }
      } catch {}
    }

    if (foundIdentity) {
      ok(`Signing: ${foundIdentity}`);
    } else {
      fail(`No signing identity for team ${teamId}`,
        'Open Xcode → Settings → Accounts → download certificates');
    }
  } else {
    fail('No appleTeamId in app.json',
      'Add "appleTeamId" to expo.ios in app.json for code signing');
  }
}

// ── Production ────────────────────────────────────────────────────────

header('Production');

if (fs.existsSync(path.join(projectRoot, 'ReactNativeNativeUserCode.podspec'))) {
  ok('ReactNativeNativeUserCode.podspec found');
} else {
  skip('ReactNativeNativeUserCode.podspec not found (needed for iOS production builds)');
}

// Check Podfile reference
try {
  const podfile = fs.readFileSync(path.join(projectRoot, 'ios/Podfile'), 'utf8');
  if (podfile.includes('ReactNativeNativeUserCode')) {
    ok('Podfile includes ReactNativeNativeUserCode');
  } else {
    skip('Podfile missing ReactNativeNativeUserCode pod');
  }
} catch {
  skip('ios/Podfile not found (CNG mode — generated at prebuild)');
}

// ── Summary ───────────────────────────────────────────────────────────

console.log('\n───────────────────────────────────────────');
if (issues === 0) {
  console.log('\x1b[32mAll checks passed!\x1b[0m\n');
} else {
  console.log(`\x1b[31m${issues} issue${issues > 1 ? 's' : ''} found\x1b[0m\n`);
}
