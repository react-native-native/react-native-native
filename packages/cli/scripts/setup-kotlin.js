#!/usr/bin/env node

/**
 * setup-kotlin.js — Sets up basic Kotlin dev hot-reload toolchain.
 *
 * Downloads the embeddable Kotlin compiler + stdlib from Maven into
 * the Gradle cache (or a local dir) so the Kotlin daemon can start
 * without needing a full Android build first.
 *
 * Run: npx @react-native-native/cli setup-kotlin
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const KOTLIN_VERSION = '2.1.20';
const gradleCache = path.join(process.env.HOME || '', '.gradle/caches/modules-2/files-2.1');

function download(url, dest) {
  return new Promise((resolve, reject) => {
    console.log(`  Downloading ${path.basename(dest)}...`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const file = fs.createWriteStream(dest);
    const request = https.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        file.close();
        fs.unlinkSync(dest);
        return download(response.headers.location, dest).then(resolve, reject);
      }
      if (response.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        return reject(new Error(`HTTP ${response.statusCode}`));
      }
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    });
    request.on('error', (err) => {
      try { fs.unlinkSync(dest); } catch {}
      reject(err);
    });
  });
}

function findJar(group, artifact) {
  const dir = path.join(gradleCache, group, artifact);
  if (!fs.existsSync(dir)) return null;
  try {
    const { execSync } = require('child_process');
    return execSync(
      `find "${dir}" -name "*.jar" -not -name "*sources*" -not -name "*javadoc*" 2>/dev/null | sort -V | tail -1`,
      { encoding: 'utf8' }
    ).trim() || null;
  } catch { return null; }
}

const MAVEN = 'https://repo1.maven.org/maven2';

const jars = [
  ['org.jetbrains.kotlin', 'kotlin-compiler-embeddable'],
  ['org.jetbrains.kotlin', 'kotlin-stdlib'],
  ['org.jetbrains.kotlin', 'kotlin-script-runtime'],
  ['org.jetbrains.kotlinx', 'kotlinx-coroutines-core-jvm'],
  ['org.jetbrains.intellij.deps', 'trove4j'],
  ['org.jetbrains', 'annotations'],
];

async function main() {
  console.log('React Native Native — Kotlin dev toolchain setup\n');

  let allFound = true;

  for (const [group, artifact] of jars) {
    const existing = findJar(group, artifact);
    if (existing) {
      console.log(`✓ ${artifact} (in Gradle cache)`);
      continue;
    }

    allFound = false;

    // Download to a local cache dir
    const localDir = path.join(process.cwd(), '.ferrum/kotlin-cache');
    fs.mkdirSync(localDir, { recursive: true });

    // Determine version — most are Kotlin version, some differ
    let version = KOTLIN_VERSION;
    if (artifact === 'trove4j') version = '1.0.20200330';
    if (artifact === 'annotations') version = '13.0';
    if (artifact === 'kotlinx-coroutines-core-jvm') version = '1.9.0';

    const groupPath = group.replace(/\./g, '/');
    const url = `${MAVEN}/${groupPath}/${artifact}/${version}/${artifact}-${version}.jar`;
    const dest = path.join(localDir, `${artifact}-${version}.jar`);

    if (fs.existsSync(dest)) {
      console.log(`✓ ${artifact} (in local cache)`);
      continue;
    }

    try {
      await download(url, dest);
      const size = fs.statSync(dest).size;
      console.log(`✓ ${artifact}-${version}.jar (${(size / 1024 / 1024).toFixed(1)}MB)`);
    } catch (e) {
      console.error(`✗ Failed to download ${artifact}: ${e.message}`);
    }
  }

  // Also need d8 from Android SDK for .dex conversion
  const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
    || path.join(process.env.HOME || '', 'Library/Android/sdk');
  const btDir = path.join(androidHome, 'build-tools');
  if (fs.existsSync(btDir)) {
    const versions = fs.readdirSync(btDir).sort();
    if (versions.length > 0) {
      console.log(`✓ d8 (Android build-tools ${versions[versions.length - 1]})`);
    }
  } else {
    console.warn('⚠ Android SDK build-tools not found. Install via Android Studio.');
  }

  console.log('\nDone. Kotlin hot-reload is ready.');
  if (!allFound) {
    console.log('Note: JARs were cached locally in .ferrum/kotlin-cache/');
    console.log('They will also be cached in Gradle after your first Android build.');
  }
}

main().catch(e => {
  console.error('Setup failed:', e.message);
  process.exit(1);
});
