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

  // ── android.jar (API stubs for type resolution) ──────────────────────
  const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
    || path.join(process.env.HOME || '', 'Library/Android/sdk');
  const platformsDir = path.join(androidHome, 'platforms');
  let hasAndroidJar = false;

  if (fs.existsSync(platformsDir)) {
    const platforms = fs.readdirSync(platformsDir).sort();
    if (platforms.length > 0) {
      const jar = path.join(platformsDir, platforms[platforms.length - 1], 'android.jar');
      if (fs.existsSync(jar)) {
        console.log(`✓ android.jar (${platforms[platforms.length - 1]})`);
        hasAndroidJar = true;
      }
    }
  }

  if (!hasAndroidJar) {
    // Download a minimal android.jar from Google's Maven
    const localDir = path.join(process.cwd(), '.ferrum/kotlin-cache');
    const androidJarDest = path.join(localDir, 'android.jar');
    if (fs.existsSync(androidJarDest)) {
      console.log(`✓ android.jar (in local cache)`);
    } else {
      console.log('  Android SDK not found — downloading android.jar...');
      // android.jar from the SDK's platforms dir. Google hosts them at dl.google.com.
      // We use the android-34 platform as a stable baseline.
      const androidJarUrl = 'https://dl.google.com/android/repository/platform-34_r03.zip';
      const zipDest = path.join(localDir, 'platform-34.zip');
      try {
        await download(androidJarUrl, zipDest);
        // Extract just android.jar from the zip
        const { execSync } = require('child_process');
        execSync(`unzip -o -q "${zipDest}" "android-34/android.jar" -d "${localDir}" 2>/dev/null`, { stdio: 'pipe' });
        const extracted = path.join(localDir, 'android-34/android.jar');
        if (fs.existsSync(extracted)) {
          fs.renameSync(extracted, androidJarDest);
          try { fs.rmdirSync(path.join(localDir, 'android-34')); } catch {}
        }
        try { fs.unlinkSync(zipDest); } catch {}
        if (fs.existsSync(androidJarDest)) {
          const size = fs.statSync(androidJarDest).size;
          console.log(`✓ android.jar (${(size / 1024 / 1024).toFixed(1)}MB, downloaded)`);
        }
      } catch (e) {
        console.warn(`⚠ Failed to download android.jar: ${e.message}`);
        console.warn('  Install Android Studio or set $ANDROID_HOME');
      }
    }
  }

  // ── d8 (.class → .dex conversion) ───────────────────────────────────
  const btDir = path.join(androidHome, 'build-tools');
  let hasD8 = false;

  if (fs.existsSync(btDir)) {
    const versions = fs.readdirSync(btDir).sort();
    if (versions.length > 0) {
      console.log(`✓ d8 (Android build-tools ${versions[versions.length - 1]})`);
      hasD8 = true;
    }
  }

  if (!hasD8) {
    // Download d8 (R8) from Maven — it's a standalone JAR
    const localDir = path.join(process.cwd(), '.ferrum/kotlin-cache');
    const d8Dest = path.join(localDir, 'd8.jar');
    if (fs.existsSync(d8Dest)) {
      console.log(`✓ d8 (in local cache)`);
    } else {
      const R8_VERSION = '8.5.35';
      const d8Url = `${MAVEN}/com/android/tools/r8/${R8_VERSION}/r8-${R8_VERSION}.jar`;
      try {
        await download(d8Url, d8Dest);
        const size = fs.statSync(d8Dest).size;
        console.log(`✓ d8/r8 (${(size / 1024 / 1024).toFixed(1)}MB, downloaded)`);
      } catch (e) {
        console.warn(`⚠ Failed to download d8: ${e.message}`);
        console.warn('  Install Android Studio or set $ANDROID_HOME');
      }
    }
  }

  console.log('\nDone. Kotlin hot-reload is ready.');
  if (!allFound || !hasAndroidJar || !hasD8) {
    console.log('Note: Missing tools were cached in .ferrum/kotlin-cache/');
  }
}

main().catch(e => {
  console.error('Setup failed:', e.message);
  process.exit(1);
});
