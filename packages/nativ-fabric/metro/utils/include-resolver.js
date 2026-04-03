/**
 * Resolves C++/ObjC++ include paths for clang invocations outside Xcode.
 * Gathers paths from: iOS SDK, CocoaPods headers, React Native, Xcode build settings.
 * Results are cached per Metro session.
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

let _cached = null;

function getIncludePaths(projectRoot) {
  if (_cached) return _cached;

  const paths = [];

  // 1. iOS SDK sysroot
  try {
    const sdk = execSync('xcrun --sdk iphonesimulator --show-sdk-path', {
      encoding: 'utf8',
    }).trim();
    paths.push(`-isysroot`, sdk);
  } catch {
    console.warn('[nativ] Could not resolve iOS SDK path');
  }

  // 2. CocoaPods public headers
  const podsPublic = path.join(projectRoot, 'ios/Pods/Headers/Public');
  if (fs.existsSync(podsPublic)) {
    paths.push(`-I${podsPublic}`);
  }

  // 3. CocoaPods private headers (for Yoga, React internals)
  const podsPrivate = path.join(projectRoot, 'ios/Pods/Headers/Private');
  if (fs.existsSync(podsPrivate)) {
    paths.push(`-I${podsPrivate}`);
  }

  // 4. React Native headers
  const rnDirs = [
    'node_modules/react-native/ReactCommon',
    'node_modules/react-native/Libraries',
    'node_modules/react-native/React',
  ];
  for (const dir of rnDirs) {
    const abs = path.join(projectRoot, dir);
    if (fs.existsSync(abs)) {
      paths.push(`-I${abs}`);
    }
  }

  // 5. Nativ.h — lives in this package's metro/ directory
  const nativHeaderDir = path.resolve(__dirname, '..');
  paths.push(`-I${nativHeaderDir}`);

  // 6. User source directories
  for (const dir of ['src', 'cpp', 'ios', 'include']) {
    const abs = path.join(projectRoot, dir);
    if (fs.existsSync(abs)) {
      paths.push(`-I${abs}`);
    }
  }

  _cached = paths;
  return paths;
}

function invalidateCache() {
  _cached = null;
}

module.exports = { getIncludePaths, invalidateCache };
