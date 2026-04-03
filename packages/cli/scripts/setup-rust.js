#!/usr/bin/env node

/**
 * setup-rust.js — Sets up Rust toolchain for native hot-reload.
 *
 * - Verifies Rust is installed (rustc + cargo)
 * - Adds iOS and Android cross-compilation targets
 * - Creates Cargo.toml with nativ-core dependency from crates.io
 *
 * Run: npx @react-native-native/cli setup-rust
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: 'pipe' }).trim();
  } catch { return null; }
}

async function main() {
  console.log('React Native Native — Rust dev toolchain setup\n');

  const projectRoot = process.cwd();

  // ── 1. Check Rust toolchain ─────────────────────────────────────────
  const rustcVersion = run('rustc --version');
  if (!rustcVersion) {
    console.error('✗ Rust not found.');
    console.error('  Install: curl --proto \'=https\' --tlsv1.2 -sSf https://sh.rustup.rs | sh');
    process.exit(1);
  }
  console.log(`✓ ${rustcVersion}`);

  const cargoVersion = run('cargo --version');
  if (cargoVersion) console.log(`✓ ${cargoVersion}`);

  // ── 2. Check/install cross-compilation targets ──────────────────────
  const installed = run('rustup target list --installed') || '';

  const platformArg = process.argv.find((a, i) => i > 0 && process.argv[i - 1] === '--platform') || 'all';
  const wantIOS = platformArg === 'all' || platformArg === 'ios';
  const wantAndroid = platformArg === 'all' || platformArg === 'android';

  const targets = [
    ...(wantIOS ? [
      'aarch64-apple-ios',           // iOS device + App Store
      'aarch64-apple-ios-sim',       // iOS simulator (Apple Silicon)
    ] : []),
    ...(wantAndroid ? [
      'aarch64-linux-android',       // Android device
      'armv7-linux-androideabi',     // Android device (older 32-bit)
      'x86_64-linux-android',        // Android emulator
    ] : []),
  ];

  for (const target of targets) {
    if (installed.includes(target)) {
      console.log(`✓ Target ${target}`);
    } else {
      console.log(`  Adding target ${target}...`);
      try {
        execSync(`rustup target add ${target}`, { stdio: 'inherit' });
        console.log(`✓ Target ${target}`);
      } catch {
        console.warn(`⚠ Failed to add ${target}. Run manually: rustup target add ${target}`);
      }
    }
  }

  // ── 3. Create Cargo.toml ────────────────────────────────────────────
  const cargoTomlPath = path.join(projectRoot, 'Cargo.toml');
  if (fs.existsSync(cargoTomlPath)) {
    console.log('✓ Cargo.toml already exists');
    // Verify nativ-core dependency is present
    const content = fs.readFileSync(cargoTomlPath, 'utf8');
    if (!content.includes('nativ-core')) {
      console.warn('⚠ Cargo.toml is missing nativ-core dependency. Add:');
      console.warn('  nativ-core = "0.1"');
    }
  } else {
    const cargoToml = `[package]
name = "native"
version = "0.1.0"
edition = "2024"

[lib]
path = ".nativ/lib.rs"

[workspace]

[dependencies]
nativ-core = "0.1"

# iOS-only dependencies — e.g. objc2
# [target.'cfg(target_os = "ios")'.dependencies]

# Android-only dependencies — e.g. jni
# [target.'cfg(target_os = "android")'.dependencies]
`;
    fs.writeFileSync(cargoTomlPath, cargoToml);
    console.log('✓ Created Cargo.toml (nativ-core = "0.1")');
  }

  // Always ensure .nativ/lib.rs exists (Cargo requires a lib target)
  const libRsPath = path.join(projectRoot, '.nativ/lib.rs');
  if (!fs.existsSync(libRsPath)) {
    fs.mkdirSync(path.join(projectRoot, '.nativ'), { recursive: true });
    fs.writeFileSync(libRsPath,
      '// Stub for rust-analyzer and `cargo add`. Do not edit.\n');
    console.log('✓ Created .nativ/lib.rs');
  }

  console.log('\nDone. Rust hot-reload is ready.');
  console.log('Add .rs files to src/ and they\'ll compile on save.');
}

main().catch(e => {
  console.error('Setup failed:', e.message);
  process.exit(1);
});
