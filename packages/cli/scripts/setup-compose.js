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

const KOTLIN_VERSION = '2.1.20';
const COMPOSE_VERSION = '1.7.0';
const COMPOSE_MATERIAL3_VERSION = '1.3.0';

const projectRoot = process.cwd();
const outDir = path.join(projectRoot, '.ferrum/compose-pretransform');
const composeJarsDir = path.join(projectRoot, '.ferrum/compose-jars');
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

function findInGradleCache(group, artifact, nameFilter) {
  const dir = path.join(gradleCache, group, artifact);
  if (!fs.existsSync(dir)) return null;
  try {
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
  const kotlinStdlib = findInGradleCache('org.jetbrains.kotlin', 'kotlin-stdlib');
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
    const jvmCp = [fullCompiler, kotlinStdlib].filter(Boolean);
    const cmd = `java -cp "${jvmCp.join(':')}" org.jetbrains.kotlin.cli.jvm.K2JVMCompiler "${srcDir}/Composables.kt" -d "${ptJar}" -classpath "${kotlinStdlib}" -no-reflect -jvm-target 17 2>&1`;
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
package com.ferrumfabric.compose

import androidx.compose.runtime.Composable
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.RowScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier

@Composable
fun Box(
    modifier: Modifier = Modifier,
    contentAlignment: Alignment = Alignment.TopStart,
    content: @Composable BoxScope.() -> Unit
) = androidx.compose.foundation.layout.Box(modifier, contentAlignment, content)

@Composable
fun Column(
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit
) = androidx.compose.foundation.layout.Column(modifier = modifier, content = content)

@Composable
fun Row(
    modifier: Modifier = Modifier,
    content: @Composable RowScope.() -> Unit
) = androidx.compose.foundation.layout.Row(modifier = modifier, content = content)

@Composable
fun Spacer(modifier: Modifier = Modifier) = androidx.compose.foundation.layout.Spacer(modifier)
`);

  // This needs the Compose plugin + all Compose JARs to compile.
  // Skip if deps aren't available — it'll be built on first Android build.
  const plugin = setupComposePlugin();
  const fullCompiler = path.join(outDir, `kotlin-compiler-${KOTLIN_VERSION}.jar`);
  const kotlinStdlib = findInGradleCache('org.jetbrains.kotlin', 'kotlin-stdlib');

  if (!plugin || !fs.existsSync(fullCompiler) || !kotlinStdlib) {
    console.warn('⚠ Cannot build compose-wrappers.jar — missing deps. Run Android build first.');
    return;
  }

  const cp = [kotlinStdlib];
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
    findInGradleCache('org.jetbrains.kotlin', 'kotlin-script-runtime'),
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
      `-no-reflect -jvm-target 17`,
    ].join(' ');
    execSync(cmd, { stdio: 'pipe', encoding: 'utf8' });
    console.log(`✓ compose-wrappers.jar (built)`);
  } catch (e) {
    console.warn(`⚠ Failed to build compose-wrappers.jar: ${(e.stderr || e.message || '').slice(0, 200)}`);
    console.warn('  This is expected on first setup. Run an Android build, then re-run this script.');
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

  console.log('\nDone. Kotlin hot-reload is ready.');
}

main().catch(e => {
  console.error('Setup failed:', e.message);
  process.exit(1);
});
