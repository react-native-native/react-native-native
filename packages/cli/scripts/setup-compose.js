#!/usr/bin/env node

/**
 * setup-kotlin.js — Sets up the Kotlin/Compose dev hot-reload toolchain.
 *
 * Downloads the non-embeddable Kotlin compiler from Maven, locates the
 * Compose compiler plugin and AAR JARs from the Gradle cache, and builds
 * the pre-transform stubs needed for standalone kotlinc compilation.
 *
 * Run: npx @react-native-native/cli setup-kotlin
 * Or:  node packages/cli/scripts/setup-kotlin.js
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const https = require('https');

// ─── Config ────────────────────────────────────────────────────────────

const projectRoot = process.cwd();

// Read Kotlin version from nativ.config.json (written by setup-kotlin)
function readKotlinVersion() {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(projectRoot, '.nativ/nativ.config.json'), 'utf8'));
    return config.kotlin?.version;
  } catch {}
  return null;
}

const KOTLIN_VERSION = readKotlinVersion() || '2.0.21';
const COMPOSE_VERSION = '1.7.0';
const COMPOSE_MATERIAL3_VERSION = '1.3.0';
const outDir = path.join(projectRoot, '.nativ/compose-pretransform');
const composeJarsDir = path.join(projectRoot, '.nativ/compose-jars');
const gradleCache = path.join(process.env.HOME || '', '.gradle/caches/modules-2/files-2.1');

// ─── Helpers ───────────────────────────────────────────────────────────

function download(url, dest) {
  return new Promise((resolve, reject) => {
    console.log(`  Downloading ${path.basename(dest)}...`);
    const file = fs.createWriteStream(dest);
    const request = (url.startsWith('https') ? https : require('http')).get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        file.close();
        fs.unlinkSync(dest);
        return download(response.headers.location, dest).then(resolve, reject);
      }
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    });
    request.on('error', (err) => { fs.unlinkSync(dest); reject(err); });
  });
}

function findInGradleCache(group, artifact, nameFilter, version) {
  const dir = path.join(gradleCache, group, artifact);
  if (!fs.existsSync(dir)) return null;
  try {
    // If version specified, look in that version's directory first
    if (version) {
      const versionDir = path.join(dir, version);
      if (fs.existsSync(versionDir)) {
        const result = execSync(
          `find "${versionDir}" -name "${nameFilter || '*.jar'}" -not -name "*sources*" -not -name "*javadoc*" 2>/dev/null | head -1`,
          { encoding: 'utf8' }
        ).trim();
        if (result && fs.existsSync(result)) return result;
      }
    }
    // Fall back to latest version
    const result = execSync(
      `find "${dir}" -name "${nameFilter || '*.jar'}" -not -name "*sources*" -not -name "*javadoc*" 2>/dev/null | sort -V | tail -1`,
      { encoding: 'utf8' }
    ).trim();
    return result && fs.existsSync(result) ? result : null;
  } catch { return null; }
}

function findAarClassesJar(group, artifact) {
  const dir = path.join(gradleCache, group, artifact);
  if (!fs.existsSync(dir)) return null;
  try {
    // Find the AAR, extract classes.jar from it
    const aar = execSync(
      `find "${dir}" -name "*.aar" 2>/dev/null | sort -V | tail -1`,
      { encoding: 'utf8' }
    ).trim();
    if (!aar) return null;

    // Check if already extracted
    const name = `${artifact.replace(/\//g, '-')}-${path.basename(path.dirname(path.dirname(aar)))}.jar`;
    const dest = path.join(composeJarsDir, name);
    if (fs.existsSync(dest)) return dest;

    // Extract classes.jar from AAR (it's a zip)
    const tmpDir = path.join(outDir, '_tmp_aar');
    fs.mkdirSync(tmpDir, { recursive: true });
    execSync(`unzip -o -q "${aar}" classes.jar -d "${tmpDir}" 2>/dev/null`, { stdio: 'pipe' });
    const classesJar = path.join(tmpDir, 'classes.jar');
    if (fs.existsSync(classesJar)) {
      fs.copyFileSync(classesJar, dest);
      fs.rmSync(tmpDir, { recursive: true });
      return dest;
    }
    fs.rmSync(tmpDir, { recursive: true });
    return null;
  } catch { return null; }
}

// ─── Step 1: Non-embeddable Kotlin compiler ────────────────────────────

async function setupKotlinCompiler() {
  const compilerJar = path.join(outDir, `kotlin-compiler-${KOTLIN_VERSION}.jar`);
  if (fs.existsSync(compilerJar)) {
    console.log(`✓ kotlin-compiler-${KOTLIN_VERSION}.jar (already exists)`);
    return compilerJar;
  }

  fs.mkdirSync(outDir, { recursive: true });
  const url = `https://repo1.maven.org/maven2/org/jetbrains/kotlin/kotlin-compiler/${KOTLIN_VERSION}/kotlin-compiler-${KOTLIN_VERSION}.jar`;
  await download(url, compilerJar);
  const size = fs.statSync(compilerJar).size;
  console.log(`✓ kotlin-compiler-${KOTLIN_VERSION}.jar (${(size / 1024 / 1024).toFixed(1)}MB)`);
  return compilerJar;
}

// ─── Step 2: Compose compiler plugin ───────────────────────────────────

function setupComposePlugin() {
  const plugin = findInGradleCache(
    'org.jetbrains.kotlin',
    'kotlin-compose-compiler-plugin',
    '*.jar'
  );
  if (plugin) {
    console.log(`✓ Compose compiler plugin (from Gradle cache)`);
    return plugin;
  }
  console.warn('⚠ Compose compiler plugin not found in Gradle cache.');
  console.warn('  Run an Android build first: npx expo run:android');
  return null;
}

// ─── Step 3: Compose AAR classes.jar ───────────────────────────────────

function setupComposeJars() {
  fs.mkdirSync(composeJarsDir, { recursive: true });

  const aars = [
    ['androidx.compose.runtime', `runtime-android`],
    ['androidx.compose.runtime', `runtime-saveable-android`],
    ['androidx.compose.ui', `ui-android`],
    ['androidx.compose.ui', `ui-graphics-android`],
    ['androidx.compose.ui', `ui-text-android`],
    ['androidx.compose.ui', `ui-unit-android`],
    ['androidx.compose.ui', `ui-geometry-android`],
    ['androidx.compose.foundation', `foundation-android`],
    ['androidx.compose.foundation', `foundation-layout-android`],
    ['androidx.compose.material3', `material3-android`],
    ['androidx.lifecycle', 'lifecycle-common'],
    ['androidx.lifecycle', 'lifecycle-runtime'],
    ['androidx.savedstate', 'savedstate'],
  ];

  let found = 0;
  for (const [group, artifact] of aars) {
    const jar = findAarClassesJar(group, artifact);
    if (jar) {
      found++;
    } else {
      // Try plain JAR (some are not AARs)
      const plainJar = findInGradleCache(group, artifact);
      if (plainJar) {
        const dest = path.join(composeJarsDir, `${artifact}.jar`);
        if (!fs.existsSync(dest)) fs.copyFileSync(plainJar, dest);
        found++;
      }
    }
  }

  console.log(`✓ Compose AAR classes.jar (${found}/${aars.length} found)`);
  if (found < aars.length) {
    console.warn('  Some JARs missing. Run an Android build first: npx expo run:android');
  }
}

// ─── Step 4: Pre-transform stubs ───────────────────────────────────────

function setupPretransformJar() {
  const ptJar = path.join(outDir, `compose-pretransform-${COMPOSE_VERSION}.jar`);
  if (fs.existsSync(ptJar)) {
    console.log(`✓ compose-pretransform-${COMPOSE_VERSION}.jar (already exists)`);
    return;
  }

  // The pretransform JAR contains stubs for inline Compose functions
  // (remember, currentComposer) that the standalone kotlinc needs.
  // These are minimal type-resolution stubs, not full implementations.
  const srcDir = path.join(outDir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });

  // Minimal remember stub
  fs.writeFileSync(path.join(srcDir, 'Composables.kt'), `
package androidx.compose.runtime

@Target(AnnotationTarget.FUNCTION, AnnotationTarget.TYPE, AnnotationTarget.TYPE_PARAMETER, AnnotationTarget.PROPERTY_GETTER)
@Retention(AnnotationRetention.BINARY)
annotation class Composable

inline fun <T> remember(crossinline calculation: @Composable () -> T): T = calculation()

@Composable
fun currentComposer(): Any? = null
`);

  // Try to compile with the Kotlin compiler
  const kotlinStdlib = findInGradleCache('org.jetbrains.kotlin', 'kotlin-stdlib', null, KOTLIN_VERSION);
  if (!kotlinStdlib) {
    console.warn('⚠ Cannot build pretransform JAR — kotlin-stdlib not in Gradle cache');
    return;
  }

  const fullCompiler = path.join(outDir, `kotlin-compiler-${KOTLIN_VERSION}.jar`);
  if (!fs.existsSync(fullCompiler)) {
    console.warn('⚠ Cannot build pretransform JAR — kotlin-compiler not downloaded yet');
    return;
  }

  try {
    const jvmCp = [
      fullCompiler,
      kotlinStdlib,
      findInGradleCache('org.jetbrains.kotlin', 'kotlin-script-runtime', null, KOTLIN_VERSION),
      findInGradleCache('org.jetbrains.kotlinx', 'kotlinx-coroutines-core-jvm'),
      findInGradleCache('org.jetbrains.intellij.deps', 'trove4j'),
      findInGradleCache('org.jetbrains', 'annotations'),
    ].filter(Boolean);
    const cmd = `java -cp "${jvmCp.join(':')}" org.jetbrains.kotlin.cli.jvm.K2JVMCompiler "${srcDir}/Composables.kt" -d "${ptJar}" -classpath "${kotlinStdlib}" -no-reflect -no-stdlib -jvm-target 17 2>&1`;
    execSync(cmd, { stdio: 'pipe', encoding: 'utf8' });
    console.log(`✓ compose-pretransform-${COMPOSE_VERSION}.jar (built)`);
  } catch (e) {
    console.warn(`⚠ Failed to build pretransform JAR: ${(e.stderr || e.message || '').slice(0, 200)}`);
  }
}

// ─── Step 5: Non-inline wrappers ───────────────────────────────────────

function setupWrappersJar() {
  const wrappersJar = path.join(outDir, 'compose-wrappers.jar');
  if (fs.existsSync(wrappersJar)) {
    console.log(`✓ compose-wrappers.jar (already exists)`);
    return;
  }

  // Non-inline wrappers for Box/Column/Row/Spacer compiled WITH the Compose plugin.
  // These delegate to the real implementations without inline body conflicts.
  const srcDir = path.join(outDir, 'wrapper-src');
  fs.mkdirSync(srcDir, { recursive: true });

  fs.writeFileSync(path.join(srcDir, 'ComposeWrappers.kt'), `
package com.nativfabric.compose

import androidx.compose.runtime.Composable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.RowScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier

@Composable
fun Box(
    modifier: Modifier = Modifier,
    contentAlignment: Alignment = Alignment.TopStart,
    propagateMinConstraints: Boolean = false,
    content: @Composable BoxScope.() -> Unit
) = androidx.compose.foundation.layout.Box(modifier, contentAlignment, propagateMinConstraints, content)

@Composable
fun Column(
    modifier: Modifier = Modifier,
    verticalArrangement: Arrangement.Vertical = Arrangement.Top,
    horizontalAlignment: Alignment.Horizontal = Alignment.Start,
    content: @Composable ColumnScope.() -> Unit
) = androidx.compose.foundation.layout.Column(modifier, verticalArrangement, horizontalAlignment, content)

@Composable
fun Row(
    modifier: Modifier = Modifier,
    horizontalArrangement: Arrangement.Horizontal = Arrangement.Start,
    verticalAlignment: Alignment.Vertical = Alignment.Top,
    content: @Composable RowScope.() -> Unit
) = androidx.compose.foundation.layout.Row(modifier, horizontalArrangement, verticalAlignment, content)

@Composable
fun Spacer(modifier: Modifier = Modifier) = androidx.compose.foundation.layout.Spacer(modifier)
`);

  // This needs the Compose plugin + all Compose JARs to compile.
  // Skip if deps aren't available — it'll be built on first Android build.
  const plugin = setupComposePlugin();
  const fullCompiler = path.join(outDir, `kotlin-compiler-${KOTLIN_VERSION}.jar`);
  const kotlinStdlib = findInGradleCache('org.jetbrains.kotlin', 'kotlin-stdlib', null, KOTLIN_VERSION);

  if (!plugin || !fs.existsSync(fullCompiler) || !kotlinStdlib) {
    console.warn('⚠ Cannot build compose-wrappers.jar — missing deps. Run Android build first.');
    return;
  }

  const cp = [kotlinStdlib];
  // Add android.jar for Android types
  const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
    || path.join(process.env.HOME || '', 'Library/Android/sdk');
  const wrapperPlatformsDir = path.join(androidHome, 'platforms');
  if (fs.existsSync(wrapperPlatformsDir)) {
    const platforms = fs.readdirSync(wrapperPlatformsDir).sort();
    if (platforms.length > 0) {
      const jar = path.join(wrapperPlatformsDir, platforms[platforms.length - 1], 'android.jar');
      if (fs.existsSync(jar)) cp.push(jar);
    }
  }
  const localAndroidJar = path.join(process.cwd(), '.nativ/kotlin-cache/android.jar');
  if (!cp.some(p => p.includes('android.jar')) && fs.existsSync(localAndroidJar)) cp.push(localAndroidJar);

  // Add all Compose JARs to classpath
  try {
    const jars = fs.readdirSync(composeJarsDir).filter(f => f.endsWith('.jar')).map(f => path.join(composeJarsDir, f));
    cp.push(...jars);
  } catch {}

  // Add pretransform JAR
  const ptJar = path.join(outDir, `compose-pretransform-${COMPOSE_VERSION}.jar`);
  if (fs.existsSync(ptJar)) cp.unshift(ptJar);

  const jvmDeps = [
    fullCompiler,
    kotlinStdlib,
    findInGradleCache('org.jetbrains.kotlin', 'kotlin-script-runtime', null, KOTLIN_VERSION),
    findInGradleCache('org.jetbrains.kotlinx', 'kotlinx-coroutines-core-jvm'),
    findInGradleCache('org.jetbrains.intellij.deps', 'trove4j'),
    findInGradleCache('org.jetbrains', 'annotations'),
  ].filter(Boolean);

  try {
    const cmd = [
      `java -cp "${jvmDeps.join(':')}" org.jetbrains.kotlin.cli.jvm.K2JVMCompiler`,
      `"${srcDir}/ComposeWrappers.kt"`,
      `-d "${wrappersJar}"`,
      `-classpath "${cp.join(':')}"`,
      `-Xplugin=${plugin}`,
      `-no-reflect -no-stdlib -jvm-target 17`,
    ].join(' ');
    execSync(cmd, { stdio: 'pipe', encoding: 'utf8' });
    console.log(`✓ compose-wrappers.jar (built)`);
  } catch (e) {
    console.warn(`⚠ Failed to build compose-wrappers.jar: ${(e.stderr || e.message || '').slice(0, 200)}`);
    console.warn('  This is expected on first setup. Run an Android build, then re-run this script.');
  }
}

// ─── Step 6: ComposeHost JAR ───────────────────────────────────────────

function setupComposeHostJar() {
  const hostJar = path.join(outDir, 'compose-host.jar');
  if (fs.existsSync(hostJar)) {
    console.log(`✓ compose-host.jar (already exists)`);
    return;
  }

  // ComposeHost wraps ComposeView.setContent for hot-reloaded .dex components.
  // Previously required a full Gradle build — now compiled standalone.
  const srcDir = path.join(outDir, 'host-src');
  fs.mkdirSync(srcDir, { recursive: true });

  fs.writeFileSync(path.join(srcDir, 'ComposeHost.kt'), `
package com.nativfabric

import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.ComposeView

object ComposeHost {
    @JvmStatic
    fun setContent(parent: ViewGroup, content: @Composable () -> Unit) {
        val composeView = ComposeView(parent.context)
        composeView.setContent { content() }
        parent.addView(composeView, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT))
    }
}
`);

  const plugin = setupComposePlugin();
  const fullCompiler = path.join(outDir, `kotlin-compiler-${KOTLIN_VERSION}.jar`);
  const kotlinStdlib = findInGradleCache('org.jetbrains.kotlin', 'kotlin-stdlib', null, KOTLIN_VERSION);

  if (!plugin || !fs.existsSync(fullCompiler) || !kotlinStdlib) {
    console.warn('⚠ Cannot build compose-host.jar — missing deps');
    return;
  }

  const cp = [kotlinStdlib];
  // Add android.jar for Android types (ViewGroup, FrameLayout, Context)
  const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
    || path.join(process.env.HOME || '', 'Library/Android/sdk');
  const platformsDir = path.join(androidHome, 'platforms');
  if (fs.existsSync(platformsDir)) {
    const platforms = fs.readdirSync(platformsDir).sort();
    if (platforms.length > 0) {
      const jar = path.join(platformsDir, platforms[platforms.length - 1], 'android.jar');
      if (fs.existsSync(jar)) cp.push(jar);
    }
  }
  // Fall back to local cache
  const localAndroidJar = path.join(process.cwd(), '.nativ/kotlin-cache/android.jar');
  if (!cp.some(p => p.includes('android.jar')) && fs.existsSync(localAndroidJar)) cp.push(localAndroidJar);

  // Add pretransform + wrappers JARs for Compose type resolution
  const ptJar = path.join(outDir, `compose-pretransform-${COMPOSE_VERSION}.jar`);
  if (fs.existsSync(ptJar)) cp.unshift(ptJar);
  const wrappersJar = path.join(outDir, 'compose-wrappers.jar');
  if (fs.existsSync(wrappersJar)) cp.unshift(wrappersJar);
  try {
    const jars = fs.readdirSync(composeJarsDir).filter(f => f.endsWith('.jar')).map(f => path.join(composeJarsDir, f));
    cp.push(...jars);
  } catch {}

  const jvmDeps = [
    fullCompiler,
    kotlinStdlib,
    findInGradleCache('org.jetbrains.kotlin', 'kotlin-script-runtime', null, KOTLIN_VERSION),
    findInGradleCache('org.jetbrains.kotlinx', 'kotlinx-coroutines-core-jvm'),
    findInGradleCache('org.jetbrains.intellij.deps', 'trove4j'),
    findInGradleCache('org.jetbrains', 'annotations'),
  ].filter(Boolean);

  try {
    const cmd = [
      `java -cp "${jvmDeps.join(':')}" org.jetbrains.kotlin.cli.jvm.K2JVMCompiler`,
      `"${srcDir}/ComposeHost.kt"`,
      `-d "${hostJar}"`,
      `-classpath "${cp.join(':')}"`,
      `-Xplugin=${plugin}`,
      `-no-reflect -jvm-target 17`,
    ].join(' ');
    execSync(cmd, { stdio: 'pipe', encoding: 'utf8' });
    console.log(`✓ compose-host.jar (built)`);
  } catch (e) {
    console.warn(`⚠ Failed to build compose-host.jar: ${(e.stderr || e.message || '').slice(0, 200)}`);
  }
}

// ─── Main ──────────────────────────────────────────────────────────────

async function main() {
  console.log('React Native Native — Kotlin/Compose dev toolchain setup\n');

  await setupKotlinCompiler();
  setupComposePlugin();
  setupComposeJars();
  setupPretransformJar();
  setupWrappersJar();
  setupComposeHostJar();

  console.log('\nDone. Compose hot-reload is ready.');
}

main().catch(e => {
  console.error('Setup failed:', e.message);
  process.exit(1);
});
