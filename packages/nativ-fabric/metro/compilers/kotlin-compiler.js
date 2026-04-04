/**
 * kotlin-compiler.js — compiles .kt files to .dex for Android hot-reload.
 *
 * Flow: .kt → kotlinc → .class → d8 → .dex → Metro serves → DexClassLoader on device
 *
 * For functions: wraps user code in a class with static methods callable via reflection.
 * For Compose components: wraps in a Composable that renders into ComposeView.
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { extractKotlinExports } = require('../extractors/kotlin-extractor');
const { compileSyncViaDaemon, isDaemonReady } = require('../utils/kotlin-daemon');

let _kotlincCmd = null;          // embeddable: 'java -cp ... K2JVMCompiler'
let _kotlincComposeCmd = null;   // full compiler for Compose: 'java -cp full-compiler.jar:... K2JVMCompiler'
let _d8Path = null;
let _androidJar = null;
let _kotlinStdlib = null;
let _composePlugin = null;       // original (non-instrumented) Compose compiler plugin JAR
let _composeJarsDir = null;      // directory with Compose Android AAR classes.jar
let _composePretransform = null; // pre-transform supplement JAR (inline bodies)
let _resolved = false;

function resolveOnce(projectRoot) {
  if (_resolved) return;
  _resolved = true;

  // Try loading cached paths from a previous run (avoids slow `find` commands)
  const cacheFile = projectRoot ? path.join(projectRoot, '.nativ/kotlin-resolve-cache.json') : null;
  if (cacheFile) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      // Verify at least one path still exists
      if (cached._kotlincCmd && cached._androidJar && fs.existsSync(cached._androidJar)) {
        _kotlincCmd = cached._kotlincCmd;
        _kotlincComposeCmd = cached._kotlincComposeCmd;
        _d8Path = cached._d8Path;
        _androidJar = cached._androidJar;
        _kotlinStdlib = cached._kotlinStdlib;
        _composePlugin = cached._composePlugin;
        _composeJarsDir = cached._composeJarsDir;
        _composePretransform = cached._composePretransform;
        if (_kotlincCmd) console.log(`[nativ] kotlinc: resolved (cached)`);
        return;
      }
    } catch {}
  }

  const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
    || path.join(process.env.HOME || '', 'Library/Android/sdk');

  // Find kotlinc — try PATH first, then Gradle cache embeddable JAR
  try {
    _kotlincCmd = execSync('which kotlinc', { encoding: 'utf8' }).trim();
  } catch {}

  if (!_kotlincCmd) {
    // Fall back to kotlin-compiler-embeddable from Gradle cache
    const gradleCache = path.join(process.env.HOME || '', '.gradle/caches/modules-2/files-2.1');
    try {
      // The embeddable compiler needs its deps on the JVM classpath
      const jvmCp = [];
      const findJar = (group, artifact) => {
        try {
          return execSync(
            `find "${gradleCache}/${group}/${artifact}" -name "*.jar" -not -name "*sources*" -not -name "*javadoc*" 2>/dev/null | sort -V | tail -1`,
            { encoding: 'utf8' }
          ).trim();
        } catch { return ''; }
      };

      const deps = [
        ['org.jetbrains.kotlin', 'kotlin-compiler-embeddable'],
        ['org.jetbrains.kotlin', 'kotlin-stdlib'],
        ['org.jetbrains.kotlin', 'kotlin-script-runtime'],
        ['org.jetbrains.kotlin', 'kotlin-reflect'],
        ['org.jetbrains.kotlin', 'kotlin-daemon-embeddable'],
        ['org.jetbrains.kotlinx', 'kotlinx-coroutines-core-jvm'],
        ['org.jetbrains.intellij.deps', 'trove4j'],
        ['org.jetbrains', 'annotations'],
      ];

      for (const [group, artifact] of deps) {
        const jarPath = findJar(group, artifact);
        if (jarPath && fs.existsSync(jarPath)) jvmCp.push(jarPath);
      }

      if (jvmCp.length >= 3) {  // compiler + stdlib + coroutines minimum
        _kotlincCmd = `java -cp "${jvmCp.join(':')}" org.jetbrains.kotlin.cli.jvm.K2JVMCompiler`;
      }
    } catch {}
  }

  // Find kotlin-stdlib jar matching the compiler version
  // (version mismatch causes metadata incompatibility errors)
  try {
    const gradleCache = path.join(process.env.HOME || '', '.gradle/caches/modules-2/files-2.1');
    // Extract compiler version from the kotlinc command or JARs
    let kotlinVersion = null;
    if (_kotlincCmd && _kotlincCmd.includes('kotlin-compiler-embeddable')) {
      const verMatch = _kotlincCmd.match(/kotlin-compiler-embeddable-(\d+\.\d+\.\d+)/);
      if (verMatch) kotlinVersion = verMatch[1];
    }

    const versionFilter = kotlinVersion
      ? `-name "kotlin-stdlib-${kotlinVersion}.jar"`
      : `-name "kotlin-stdlib-*.jar" -not -name "*sources*"`;

    const stdlibPath = execSync(
      `find "${gradleCache}/org.jetbrains.kotlin/kotlin-stdlib" ${versionFilter} 2>/dev/null | sort -V | tail -1`,
      { encoding: 'utf8' }
    ).trim();
    if (stdlibPath && fs.existsSync(stdlibPath)) {
      _kotlinStdlib = stdlibPath;
    }
  } catch {}

  // Find d8 from build-tools, fall back to local cache
  const btDir = path.join(androidHome, 'build-tools');
  if (fs.existsSync(btDir)) {
    const versions = fs.readdirSync(btDir).sort();
    if (versions.length > 0) {
      const d8 = path.join(btDir, versions[versions.length - 1], 'd8');
      if (fs.existsSync(d8)) _d8Path = d8;
    }
  }
  if (!_d8Path && projectRoot) {
    const localD8 = path.join(projectRoot, '.nativ/kotlin-cache/d8.jar');
    if (fs.existsSync(localD8)) _d8Path = `java -jar "${localD8}"`;
  }

  // Find android.jar for compilation classpath, fall back to local cache
  const platformsDir = path.join(androidHome, 'platforms');
  if (fs.existsSync(platformsDir)) {
    const platforms = fs.readdirSync(platformsDir).sort();
    if (platforms.length > 0) {
      const jar = path.join(platformsDir, platforms[platforms.length - 1], 'android.jar');
      if (fs.existsSync(jar)) _androidJar = jar;
    }
  }
  if (!_androidJar && projectRoot) {
    const localJar = path.join(projectRoot, '.nativ/kotlin-cache/android.jar');
    if (fs.existsSync(localJar)) _androidJar = localJar;
  }

  // Find Compose compiler plugin (original, non-instrumented) + full compiler
  try {
    const gradleCache = path.join(process.env.HOME || '', '.gradle/caches/modules-2/files-2.1');
    // The original plugin JAR (needs the non-embeddable compiler)
    const plugin = execSync(
      `find "${gradleCache}/org.jetbrains.kotlin/kotlin-compose-compiler-plugin" -name "*.jar" -not -name "*sources*" 2>/dev/null | sort -V | tail -1`,
      { encoding: 'utf8' }
    ).trim();
    if (plugin && fs.existsSync(plugin)) _composePlugin = plugin;

    // Build the full (non-embeddable) compiler command for Compose
    // Build the full (non-embeddable) compiler command for Compose
    // The full compiler has un-shaded com.intellij.* classes that the Compose plugin needs
    if (_composePlugin && projectRoot) {
      // Read Kotlin version from config, fall back to scanning for any kotlin-compiler-*.jar
      let _ktVersion = null;
      try {
        const cfg = JSON.parse(fs.readFileSync(path.join(projectRoot, '.nativ/nativ.config.json'), 'utf8'));
        _ktVersion = cfg.kotlin?.version;
      } catch {}
      const fullCompiler = _ktVersion
        ? path.join(projectRoot, `.nativ/compose-pretransform/kotlin-compiler-${_ktVersion}.jar`)
        : (() => {
            try {
              const files = fs.readdirSync(path.join(projectRoot, '.nativ/compose-pretransform'));
              const match = files.find(f => f.startsWith('kotlin-compiler-') && f.endsWith('.jar'));
              return match ? path.join(projectRoot, '.nativ/compose-pretransform', match) : '';
            } catch { return ''; }
          })();
      if (fs.existsSync(fullCompiler)) {
        // Version from full compiler JAR — Kotlin deps must match to avoid metadata crashes
        const compilerVer = path.basename(fullCompiler).match(/kotlin-compiler-(\d+\.\d+\.\d+)\.jar/)?.[1];
        const findJar = (group, artifact, version) => {
          try {
            const filter = version
              ? `-name "${artifact}-${version}.jar"`
              : `-name "${artifact}-*.jar" -not -name "*sources*" -not -name "*javadoc*"`;
            return execSync(
              `find "${gradleCache}/${group}/${artifact}" ${filter} 2>/dev/null | sort -V | tail -1`,
              { encoding: 'utf8' }
            ).trim();
          } catch { return ''; }
        };

        // The full compiler JAR bundles its own kotlin classes — only add deps it needs externally
        const jvmDeps = [
          fullCompiler,
          findJar('org.jetbrains.intellij.deps', 'trove4j'),
          findJar('org.jetbrains', 'annotations'),
        ].filter(Boolean);

        if (jvmDeps.length >= 4) {
          _kotlincComposeCmd = `java -cp "${jvmDeps.join(':')}" org.jetbrains.kotlin.cli.jvm.K2JVMCompiler`;
        }
      }
    }
  } catch {}

  // Set up Compose JARs directory (Android AAR classes.jar for runtime resolution)
  if (projectRoot) {
    _composeJarsDir = path.join(projectRoot, '.nativ/compose-jars');
    if (!fs.existsSync(_composeJarsDir) || fs.readdirSync(_composeJarsDir).length === 0) {
      _composeJarsDir = null;
    }
    // Pre-transform supplement JAR (inline bodies for remember, Box, Column, Row)
    const ptJar = path.join(projectRoot, '.nativ/compose-pretransform/compose-pretransform-1.7.0.jar');
    if (fs.existsSync(ptJar)) _composePretransform = ptJar;
  }

  if (_kotlincCmd) console.log(`[nativ] kotlinc: ${_kotlincCmd.split(' ')[0] === 'java' ? 'embeddable JAR' : _kotlincCmd}`);
  if (_d8Path) console.log(`[nativ] d8: ${_d8Path}`);
  if (_androidJar) console.log(`[nativ] android.jar: ${path.basename(path.dirname(_androidJar))}`);
  if (_kotlincComposeCmd) console.log(`[nativ] compose: full compiler + plugin + pretransform`);
  else if (_composePlugin) console.log(`[nativ] compose: plugin found but missing full compiler`);

  // Cache resolved paths for fast startup in Metro workers
  if (cacheFile) {
    try {
      fs.writeFileSync(cacheFile, JSON.stringify({
        _kotlincCmd, _kotlincComposeCmd, _d8Path, _androidJar, _kotlinStdlib,
        _composePlugin, _composeJarsDir, _composePretransform,
      }));
    } catch {}
  }
}

/**
 * Compile a Kotlin function file to .dex for hot-reload.
 * Returns path to the .dex file, or null on failure.
 */
function compileKotlinDex(filepath, projectRoot) {
  resolveOnce(projectRoot);
  if (!_kotlincCmd || !_d8Path || !_androidJar) {
    console.warn('[nativ] Kotlin toolchain incomplete — skipping compilation');
    return null;
  }

  const name = path.basename(filepath, '.kt');
  const moduleId = name.toLowerCase();
  // .dex is arch-independent but middleware serves from dylibs/{target}/
  const target = fs.existsSync(path.join(projectRoot, '.nativ/android-target'))
    ? fs.readFileSync(path.join(projectRoot, '.nativ/android-target'), 'utf8').trim()
    : 'arm64-v8a';
  const outputDir = path.join(projectRoot, '.nativ/dylibs', target);
  const buildDir = path.join(projectRoot, '.nativ/build', `kt_${moduleId}`);
  fs.mkdirSync(buildDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

  const { functions, isComponent, componentProps } = extractKotlinExports(filepath);

  if (!isComponent && functions.length === 0) {
    console.warn(`[nativ] No @nativ_export/@nativ_component in ${name}.kt`);
    return null;
  }

  // Content-addressed cache: each source hash gets its own .dex
  // Reverts (A→B→A) are instant — the .dex for A is already on disk.
  const srcHash = require('crypto').createHash('md5').update(fs.readFileSync(filepath)).digest('hex').slice(0, 8);
  const className = `NativModule_${moduleId}`;
  const dexBase = isComponent ? `nativ_${moduleId}` : moduleId;
  const dexName = `${dexBase}_${srcHash}.dex`;
  const dexPath = path.join(outputDir, dexName);

  if (fs.existsSync(dexPath)) {
    console.log(`[nativ] ${name}.kt cache hit (${srcHash})`);
    return dexPath;
  }

  if (isComponent) {
    return compileKotlinComponent(filepath, projectRoot, name, moduleId,
                                   componentProps, buildDir, dexPath, className);
  }

  // Generate wrapper class with static methods
  const wrapperSrc = generateFunctionWrapper(filepath, functions, className, moduleId);
  const wrapperPath = path.join(buildDir, `${className}.kt`);
  fs.writeFileSync(wrapperPath, wrapperSrc);

  return compileAndDex(wrapperPath, buildDir, dexPath, moduleId);
}

function generateFunctionWrapper(filepath, functions, className, moduleId) {
  const userSrc = fs.readFileSync(filepath, 'utf8');

  // Strip @nativ_export comments and existing package declaration
  const cleanSrc = userSrc
    .replace(/\/\/\s*@nativ_export\s*\([^)]*\)\s*\n/g, '')
    .replace(/^package\s+[^\n]+\n/m, '');

  const lines = [
    `// Auto-generated wrapper for ${moduleId}.kt`,
    `package com.nativfabric.generated`,
    '',
  ];

  // Include the user's functions
  lines.push(cleanSrc);
  lines.push('');

  // Minimal JSON array parser (no external deps — avoids android.jar issues)
  lines.push(`private fun _parseArgs(json: String): List<String> {`);
  lines.push(`    val s = json.trim().removePrefix("[").removeSuffix("]")`);
  lines.push(`    if (s.isBlank()) return emptyList()`);
  lines.push(`    val result = mutableListOf<String>()`);
  lines.push(`    var i = 0; var inStr = false; var esc = false; val buf = StringBuilder()`);
  lines.push(`    while (i < s.length) {`);
  lines.push(`        val c = s[i]`);
  lines.push(`        when {`);
  lines.push(`            esc -> { buf.append(c); esc = false }`);
  lines.push(`            c == '\\\\' -> esc = true`);
  lines.push(`            c == '"' -> inStr = !inStr`);
  lines.push(`            c == ',' && !inStr -> { result.add(buf.toString().trim()); buf.clear() }`);
  lines.push(`            else -> buf.append(c)`);
  lines.push(`        }; i++`);
  lines.push(`    }`);
  lines.push(`    if (buf.isNotEmpty()) result.add(buf.toString().trim())`);
  lines.push(`    return result`);
  lines.push(`}`);
  lines.push('');

  // Generate a class with a dispatch method
  lines.push(`object ${className} {`);
  lines.push('    @JvmStatic');
  lines.push('    fun dispatch(fnName: String, argsJson: String): String {');
  lines.push('        val args = _parseArgs(argsJson)');
  lines.push('        return when (fnName) {');

  for (const fn of functions) {
    const argExprs = fn.args.map((a, i) => {
      switch (a.type) {
        case 'Int': return `args[${i}].toInt()`;
        case 'Long': return `args[${i}].toLong()`;
        case 'Float': return `args[${i}].toFloat()`;
        case 'Double': return `args[${i}].toDouble()`;
        case 'Boolean': return `args[${i}].toBoolean()`;
        case 'String': return `args[${i}]`;
        default: return `args[${i}]`;
      }
    });

    const call = `${fn.name}(${argExprs.join(', ')})`;

    if (fn.ret === 'String') {
      lines.push(`            "${fn.name}" -> "\\"" + ${call} + "\\""`);
    } else if (fn.ret === 'Unit') {
      lines.push(`            "${fn.name}" -> { ${call}; "null" }`);
    } else {
      lines.push(`            "${fn.name}" -> ${call}.toString()`);
    }
  }

  lines.push('            else -> "null"');
  lines.push('        }');
  lines.push('    }');
  lines.push('}');

  return lines.join('\n');
}

function compileKotlinComponent(filepath, projectRoot, name, moduleId,
                                 componentProps, buildDir, dexPath, className) {
  const userSrc = fs.readFileSync(filepath, 'utf8');
  const isCompose = userSrc.includes('@Composable');

  // Strip annotations, package, imports — wrapper provides its own
  const cleanSrc = userSrc
    .replace(/\/\/\s*@nativ_component\s*\n/g, '')
    .replace(/^package\s+[^\n]+\n/m, '')
    .replace(/^import\s+[^\n]+\n/gm, '');

  let userImports = [...userSrc.matchAll(/^(import\s+[^\n]+)\n/gm)]
    .map(m => m[1]);

  if (isCompose) {
    // Rewrite imports for inline layout functions to use our non-inline wrappers
    // (compiling without the plugin — pretransform JAR provides inline bodies)
    const wrapperRewrites = {
      'androidx.compose.foundation.layout.Box': 'com.nativfabric.compose.Box',
      'androidx.compose.foundation.layout.Column': 'com.nativfabric.compose.Column',
      'androidx.compose.foundation.layout.Row': 'com.nativfabric.compose.Row',
      'androidx.compose.foundation.layout.Spacer': 'com.nativfabric.compose.Spacer',
    };
    userImports = userImports.map(imp => {
      for (const [from, to] of Object.entries(wrapperRewrites)) {
        if (imp.includes(from)) return imp.replace(from, to);
      }
      if (imp.includes('androidx.compose.foundation.layout.*')) {
        return imp + '\nimport com.nativfabric.compose.*';
      }
      return imp;
    });
    // Compose component — needs ComposeView wrapper (requires Compose compiler plugin)
    const lines = [
      `// Auto-generated Compose component wrapper for ${moduleId}.kt`,
      `package com.nativfabric.generated`,
      '',
      'import android.view.ViewGroup',
      'import android.widget.FrameLayout',
      'import androidx.compose.runtime.*',
      'import androidx.compose.ui.platform.ComposeView',
      ...userImports,
      '',
      cleanSrc,
      '',
      `object ${className} {`,
      '    @JvmStatic',
      '    fun render(parent: ViewGroup, props: Map<String, Any?>) {',
      '        val composeView = ComposeView(parent.context)',
      '        composeView.setContent {',
    ];

    const compFnMatch = cleanSrc.match(/@Composable\s+fun\s+(\w+)\s*\(([^)]*)\)/);
    const compFnName = compFnMatch ? compFnMatch[1] : name;
    const compParams = compFnMatch && compFnMatch[2] ? compFnMatch[2].trim() : '';

    if (compParams) {
      const args = compParams.split(',').map(p => p.trim()).filter(Boolean);
      const argExprs = args.map(p => {
        const m = p.match(/(\w+)\s*:\s*(.+)/);
        if (!m) return null;
        const [, pName, pType] = m;
        const t = pType.trim();
        if (t === 'String') return `                ${pName} = props["${pName}"] as? String ?: ""`;
        if (t === 'Int') return `                ${pName} = (props["${pName}"] as? Number)?.toInt() ?: 0`;
        if (t === 'Float' || t === 'Double') return `                ${pName} = (props["${pName}"] as? Number)?.toDouble() ?: 0.0`;
        if (t === 'Boolean') return `                ${pName} = props["${pName}"] as? Boolean ?: false`;
        if (t.includes('->')) return `                ${pName} = {}`;
        return `                ${pName} = props["${pName}"]`;
      }).filter(Boolean);

      lines.push(`            ${compFnName}(`);
      lines.push(argExprs.join(',\n'));
      lines.push('            )');
    } else {
      lines.push(`            ${compFnName}()`);
    }
    lines.push('        }');
    lines.push('        parent.addView(composeView, FrameLayout.LayoutParams(');
    lines.push('            FrameLayout.LayoutParams.MATCH_PARENT,');
    lines.push('            FrameLayout.LayoutParams.MATCH_PARENT))');
    lines.push('    }');
    lines.push('}');

    const wrapperPath = path.join(buildDir, `${className}.kt`);
    fs.writeFileSync(wrapperPath, lines.join('\n'));
    return compileAndDex(wrapperPath, buildDir, dexPath, moduleId, true, projectRoot);
  }

  // Plain View component — user function has signature: fun Name(parent: ViewGroup, props: Map<...>)
  // Just wrap it in an object with a static render() that delegates to the user function.
  const fnMatch = cleanSrc.match(/fun\s+(\w+)\s*\(\s*parent\s*:/);
  const fnName = fnMatch ? fnMatch[1] : name;

  const lines = [
    `// Auto-generated View component wrapper for ${moduleId}.kt`,
    `package com.nativfabric.generated`,
    '',
    ...userImports,
    '',
    cleanSrc,
    '',
    `object ${className} {`,
    '    @JvmStatic',
    '    fun render(parent: android.view.ViewGroup, props: Map<String, Any?>) {',
    `        ${fnName}(parent, props)`,
    '    }',
    '}',
  ];

  const wrapperPath = path.join(buildDir, `${className}.kt`);
  fs.writeFileSync(wrapperPath, lines.join('\n'));
  return compileAndDex(wrapperPath, buildDir, dexPath, moduleId);
}

function compileAndDex(ktPath, buildDir, dexPath, moduleId, isCompose, projectRoot) {
  const classDir = path.join(buildDir, 'classes');
  // Clean previous classes to avoid stale files
  try { fs.rmSync(classDir, { recursive: true }); } catch {}
  fs.mkdirSync(classDir, { recursive: true });

  // Step 1: kotlinc → .class files
  const cp = [_androidJar];

  // Compose needs version-matched stdlib (compiler 2.1.20 can't analyze 2.3.0 metadata)
  if (isCompose && _kotlincComposeCmd) {
    const matched = _kotlincComposeCmd.split(':').find(p => p.includes('kotlin-stdlib'));
    cp.push(matched || _kotlinStdlib);
  } else if (_kotlinStdlib) {
    cp.push(_kotlinStdlib);
  }

  // Add Compose JARs for Compose components
  if (isCompose) {
    // Pre-transform JAR for remember inline body
    if (_composePretransform) cp.unshift(_composePretransform);
    // Non-inline wrappers for Box/Column/Row/Spacer (compiled with Compose plugin)
    const wrappersJar = _composePretransform
      ? path.join(path.dirname(_composePretransform), 'compose-wrappers.jar')
      : null;
    if (wrappersJar && fs.existsSync(wrappersJar)) cp.unshift(wrappersJar);

    // Published Android AAR classes.jar for all other types
    if (_composeJarsDir) {
      try {
        const jars = fs.readdirSync(_composeJarsDir)
          .filter(f => f.endsWith('.jar'))
          .map(f => path.join(_composeJarsDir, f));
        cp.push(...jars);
      } catch {}
    }

    // ComposeHost JAR (built by setup-compose, no Gradle build needed)
    if (projectRoot) {
      const hostJar = path.join(projectRoot, '.nativ/compose-pretransform/compose-host.jar');
      if (fs.existsSync(hostJar)) cp.push(hostJar);
    }
  }

  // Use JVM full compiler for Compose (version-matched with plugin), system kotlinc for everything else
  const compilerCmd = (isCompose && _kotlincComposeCmd) ? _kotlincComposeCmd : _kotlincCmd;

  const kotlincCmd = [
    compilerCmd,
    ktPath,
    '-d', classDir,
    '-classpath', cp.join(':'),
    '-no-reflect',
    '-jvm-target', '17',
  ];

  // Add Compose compiler plugin via -Xplugin (only with version-matched full compiler)
  if (isCompose && _composePlugin && _kotlincComposeCmd) {
    kotlincCmd.push(`-Xplugin=${_composePlugin}`);
  }

  // Step 1: kotlinc → .class
  const _t0 = Date.now();
  let compiled = false;
  let via = 'execSync';

  if (!isCompose && isDaemonReady()) {
    const result = compileSyncViaDaemon({
      sourceFile: ktPath,
      outputDir: classDir,
      classpath: cp.join(':'),
      plugin: '',
      dexOutput: dexPath,
      androidJar: _androidJar || '',
    });
    if (result && result.success) {
      compiled = true;
      via = `daemon(kotlinc=${result.kotlincMs || result.ms || '?'}ms, d8=${result.d8Ms || '?'}ms)`;
      if (result.d8Ms !== undefined && result.d8Ms > 0) {
        // Daemon did kotlinc+d8 — skip the separate d8 step below
        const size = fs.existsSync(dexPath) ? fs.statSync(dexPath).size : 0;
        console.log(`[nativ] ${moduleId}.kt: ${via}, total ${Date.now() - _t0}ms → ${(size / 1024).toFixed(1)}KB`);
        return dexPath;
      }
    } else if (result) {
      console.error(`[nativ] Daemon compile failed: ${result.error?.slice(0, 500)}`);
    }
  }

  if (!compiled) {
    const _cmd = kotlincCmd.join(' ');
    try {
      execSync(_cmd, { stdio: 'pipe', encoding: 'utf8' });
    } catch (err) {
      console.error(`[nativ] Kotlin compile failed: ${moduleId}.kt`);
      console.error((err.stderr || '').slice(0, 2000));
      return null;
    }
  }

  const _t1 = Date.now();
  console.log(`[nativ] ${moduleId}.kt: kotlinc ${via} ${_t1 - _t0}ms`);

  // Step 2: d8 → .dex
  // Find all .class files
  const classFiles = [];
  function findClasses(dir) {
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      if (fs.statSync(full).isDirectory()) findClasses(full);
      else if (f.endsWith('.class')) classFiles.push(full);
    }
  }
  findClasses(classDir);

  if (classFiles.length === 0) {
    console.error(`[nativ] No .class files produced for ${moduleId}.kt`);
    return null;
  }

  // Use per-module temp dir for d8 output to avoid classes.dex rename races
  const d8OutDir = path.join(buildDir, 'd8out');
  try { fs.rmSync(d8OutDir, { recursive: true }); } catch {}
  fs.mkdirSync(d8OutDir, { recursive: true });

  const d8Cmd = [
    _d8Path,
    '--output', d8OutDir,
    '--lib', _androidJar,
    '--min-api', isCompose ? '26' : '24',
    ...(isCompose ? [] : ['--no-desugaring']),
  ];

  // Add classpath for d8 to resolve references to Compose/stdlib classes
  if (_kotlinStdlib) d8Cmd.push('--classpath', _kotlinStdlib);
  if (isCompose && _composeJarsDir) {
    try {
      for (const f of fs.readdirSync(_composeJarsDir)) {
        if (f.endsWith('.jar')) d8Cmd.push('--classpath', path.join(_composeJarsDir, f));
      }
    } catch {}
  }

  // Write class files to an argfile to avoid shell $ expansion in filenames
  const d8ArgFile = path.join(buildDir, 'd8-args.txt');
  fs.writeFileSync(d8ArgFile, classFiles.join('\n'));

  const _t2 = Date.now();
  try {
    execSync(d8Cmd.join(' ') + ` @${d8ArgFile}`, { stdio: 'pipe', encoding: 'utf8' });
    // d8 outputs classes.dex in per-module temp dir — move to target
    const d8Output = path.join(d8OutDir, 'classes.dex');
    if (fs.existsSync(d8Output)) {
      fs.renameSync(d8Output, dexPath);
    }
  } catch (err) {
    console.error(`[nativ] d8 failed: ${moduleId}`);
    console.error((err.stderr || '').slice(0, 1000));
    return null;
  }

  const _t3 = Date.now();
  const size = fs.statSync(dexPath).size;
  console.log(`[nativ] ${moduleId}.kt: d8 ${_t3 - _t2}ms → ${(size / 1024).toFixed(1)}KB (total ${_t3 - _t0}ms)`);

  return dexPath;
}

module.exports = { compileKotlinDex, extractKotlinExports };
