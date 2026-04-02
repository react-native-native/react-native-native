/**
 * CppDaemon — watches .cpp/.mm/.cc files, compiles to signed arm64 dylibs,
 * and signals Metro when builds complete so HMR can fire.
 *
 * The compiled dylib is served by Metro's dev server. The app downloads it
 * to its sandbox and dlopen's it — the __attribute__((constructor)) in the
 * bridge re-registers functions, replacing the statically-linked versions.
 */

const { execSync, exec } = require('child_process');
const EventEmitter = require('events');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

class CppDaemon extends EventEmitter {
  constructor(projectRoot, includePaths) {
    super();
    this.projectRoot = projectRoot;
    this.includePaths = includePaths;
    this.building = new Set();
    this.outputDir = path.join(projectRoot, '.nativ/dylibs');
    this.sdkPath = null;
    this.signingIdentity = null;
    this._watcher = null;
  }

  start() {
    fs.mkdirSync(this.outputDir, { recursive: true });

    // Resolve SDK and signing identity once
    try {
      this.sdkPath = execSync('xcrun --sdk iphoneos --show-sdk-path', {
        encoding: 'utf8',
      }).trim();
    } catch {
      console.warn('[ferrum] Could not resolve iphoneos SDK, falling back to iphonesimulator');
      try {
        this.sdkPath = execSync('xcrun --sdk iphonesimulator --show-sdk-path', {
          encoding: 'utf8',
        }).trim();
      } catch {
        console.error('[ferrum] No iOS SDK found');
        return;
      }
    }

    try {
      const identities = execSync('security find-identity -v -p codesigning', {
        encoding: 'utf8',
      });
      const match = identities.match(/"(Apple Development:[^"]+)"/);
      if (match) {
        this.signingIdentity = match[1];
        console.log(`[ferrum] Signing identity: ${this.signingIdentity}`);
      }
    } catch {
      console.warn('[ferrum] No signing identity found — dylibs will be unsigned');
    }

    // No file watcher needed — Metro's watcher sees .cpp changes and the
    // transformer calls buildAndWait() directly. This avoids double-refresh.
    console.log('[ferrum] CppDaemon started');
  }

  _startWatcher() {
    // Use fs.watch recursively — no chokidar dependency needed
    const watchDirs = [this.projectRoot];
    const ignore = new Set(['node_modules', 'ios', 'android', '.nativ', '.git', 'build', 'Pods']);

    const self = this;

    function watchDir(dir) {
      try {
        const watcher = fs.watch(dir, { recursive: false }, (eventType, filename) => {
          if (!filename) return;
          if (/\.(cpp|cc|mm)$/.test(filename)) {
            const fullPath = path.join(dir, filename);
            if (fs.existsSync(fullPath)) {
              self._onFileChange(fullPath);
            }
          }
        });
        // Watch subdirectories
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory() && !ignore.has(entry.name) && !entry.name.startsWith('.')) {
            watchDir(path.join(dir, entry.name));
          }
        }
      } catch {
        // Permission errors, etc.
      }
    }

    watchDir(this.projectRoot);
  }

  _onFileChange(filepath) {
    // Debounce — skip if already building this file
    if (this.building.has(filepath)) return;

    // Only rebuild files that have NATIV_EXPORT
    try {
      const src = fs.readFileSync(filepath, 'utf8');
      if (!src.includes('NATIV_EXPORT')) return;
    } catch {
      return;
    }

    console.log(`[ferrum] File changed: ${path.relative(this.projectRoot, filepath)}`);
    this._rebuildFile(filepath);
  }

  _rebuildFile(filepath) {
    const rel = path.relative(this.projectRoot, filepath);
    const moduleId = rel
      .replace(/\.(cpp|cc|mm)$/, '')
      .replace(/[\/\\]/g, '_')
      .replace(/[^a-zA-Z0-9_]/g, '_');

    const dylibPath = path.join(this.outputDir, `${moduleId}.dylib`);

    this.building.add(filepath);
    this.emit('build:start', filepath);
    console.log(`[ferrum] Building dylib for ${rel}...`);

    const isObjCpp = filepath.endsWith('.mm');
    const lang = isObjCpp ? 'objective-c++' : 'c++';

    // Keep sysroot for device compilation, filter for host-only paths
    const hostPaths = this.includePaths.filter((p, i, arr) => {
      if (p === '-isysroot') return false;
      if (i > 0 && arr[i - 1] === '-isysroot') return false;
      return true;
    });

    // Extract exports
    const { extractCppExports } = require('../extractors/cpp-ast-extractor');
    const exports = extractCppExports(filepath, this.includePaths, null);

    if (exports.length === 0) {
      console.warn(`[ferrum] No NATIV_EXPORT functions in ${rel}, skipping dylib`);
      this.building.delete(filepath);
      this.emit('build:error', filepath, 'No exports found');
      return;
    }

    const bridgePath = filepath.replace(/\.(cpp|cc|mm)$/, '_bridge_hot.cpp');
    const bridgeSource = this._generateBridge(exports, moduleId);
    fs.writeFileSync(bridgePath, bridgeSource);

    // Compile source + bridge → dylib
    const cmd = [
      'clang++',
      '-x', lang,
      '-std=c++17',
      '-arch', 'arm64',
      '-dynamiclib',
      '-fPIC',
      '-isysroot', this.sdkPath,
      ...hostPaths,
      // Link against the app's static lib for the registry symbols
      '-undefined', 'dynamic_lookup',
      '-o', dylibPath,
      filepath,
      bridgePath,
    ];

    if (isObjCpp) {
      cmd.push('-framework', 'Foundation');
    }

    exec(cmd.join(' '), { encoding: 'utf8' }, (err, stdout, stderr) => {
      this.building.delete(filepath);

      // Clean up bridge file
      try { fs.unlinkSync(bridgePath); } catch {}

      if (err) {
        console.error(`[ferrum] Build failed: ${path.basename(filepath)}`);
        console.error(stderr.slice(0, 500));
        this.emit('build:error', filepath, stderr);
        return;
      }

      // Sign the dylib
      if (this.signingIdentity) {
        try {
          execSync(`codesign -fs "${this.signingIdentity}" "${dylibPath}"`, {
            stdio: 'pipe',
          });
        } catch (signErr) {
          console.warn(`[ferrum] Signing failed (will try unsigned): ${signErr.message}`);
        }
      }

      const size = fs.statSync(dylibPath).size;
      console.log(`[ferrum] Built ${moduleId}.dylib (${(size / 1024).toFixed(1)}KB)`);
      this.emit('build:complete', filepath, moduleId, dylibPath);
    });
  }

  _generateBridge(exports, moduleId) {
    const lines = [
      '// Hot-reload bridge — auto-generated',
      '#include <string>',
      '#include <cstdlib>',
      '',
      '// Forward declarations',
    ];

    for (const fn of exports) {
      const argTypes = fn.args.map(a => a.type + ' ' + a.name).join(', ');
      lines.push(`extern ${fn.ret} ${fn.name}(${argTypes});`);
    }

    lines.push('', '// Registry C API', 'extern "C" {');
    lines.push('typedef const char* (*NativSyncFn)(const char*);');
    lines.push('typedef void (*NativAsyncFn)(const char*, void(*)(const char*), void(*)(const char*, const char*));');
    lines.push('void nativ_register_sync(const char*, const char*, NativSyncFn);');
    lines.push('void nativ_register_async(const char*, const char*, NativAsyncFn);');
    lines.push('}');
    lines.push('');

    // Minimal JSON helpers inline
    lines.push('static double _parseNumber(const char* &p) {');
    lines.push('  while (*p == \' \' || *p == \',\' || *p == \'[\') p++;');
    lines.push('  char* end; double v = strtod(p, &end); p = end; return v;');
    lines.push('}');
    lines.push('static std::string _parseString(const char* &p) {');
    lines.push('  while (*p && *p != \'"\') p++; if (*p == \'"\') p++;');
    lines.push('  std::string s; while (*p && *p != \'"\') { if (*p == \'\\\\\' && *(p+1)) { p++; s += *p; } else { s += *p; } p++; }');
    lines.push('  if (*p == \'"\') p++; return s;');
    lines.push('}');
    lines.push('');

    lines.push('extern "C" {');

    for (const fn of exports) {
      const isSync = !fn.async;
      if (isSync) {
        lines.push(`static const char* nativ_cpp_${moduleId}_${fn.name}(const char* argsJson) {`);
        lines.push('  const char* p = argsJson;');
        lines.push('  while (*p && *p != \'[\') p++; if (*p == \'[\') p++;');

        // Generate arg extraction
        const argNames = [];
        for (const arg of fn.args) {
          const t = arg.type.replace(/const\s+/, '').replace(/\s*&\s*$/, '').trim();
          if (t === 'std::string') {
            lines.push(`  std::string ${arg.name} = _parseString(p);`);
          } else {
            lines.push(`  ${arg.type} ${arg.name} = (${arg.type})_parseNumber(p);`);
          }
          argNames.push(arg.name);
        }

        lines.push(`  auto result = ${fn.name}(${argNames.join(', ')});`);

        // Return type handling
        const retBase = fn.ret.replace(/const\s+/, '').replace(/\s*&\s*$/, '').trim();
        if (retBase === 'std::string') {
          lines.push('  static thread_local std::string buf;');
          lines.push('  buf = "\\""; for (char c : result) { if (c == \'"\') buf += "\\\\\\\\\\""; else buf += c; } buf += "\\"";');
          lines.push('  return buf.c_str();');
        } else {
          lines.push('  static thread_local std::string buf;');
          lines.push('  buf = std::to_string(result);');
          lines.push('  return buf.c_str();');
        }
        lines.push('}');
      }
    }

    // Constructor — re-registers, replacing statically-linked versions
    lines.push('');
    lines.push('__attribute__((constructor))');
    lines.push(`static void nativ_cpp_register_${moduleId}() {`);
    for (const fn of exports) {
      if (!fn.async) {
        lines.push(`  nativ_register_sync("${moduleId}", "${fn.name}", nativ_cpp_${moduleId}_${fn.name});`);
      } else {
        // TODO: async bridge
      }
    }
    lines.push('}');
    lines.push('');
    lines.push('} // extern "C"');

    return lines.join('\n');
  }

  /**
   * Triggers a build for `filepath` and returns a promise that resolves
   * when the build completes. Called by the Metro transformer so HMR
   * waits until the dylib is ready.
   */
  buildAndWait(filepath) {
    console.log(`[ferrum] buildAndWait: ${path.basename(filepath)}`);
    return new Promise((resolve) => {
      const onComplete = (builtPath) => {
        if (builtPath === filepath) {
          this.removeListener('build:complete', onComplete);
          this.removeListener('build:error', onError);
          console.log(`[ferrum] buildAndWait resolved (complete): ${path.basename(filepath)}`);
          resolve();
        }
      };
      const onError = (errorPath) => {
        if (errorPath === filepath) {
          this.removeListener('build:complete', onComplete);
          this.removeListener('build:error', onError);
          console.log(`[ferrum] buildAndWait resolved (error): ${path.basename(filepath)}`);
          resolve();
        }
      };
      this.on('build:complete', onComplete);
      this.on('build:error', onError);

      // Trigger the build (skips if already building this file)
      if (!this.building.has(filepath)) {
        this._rebuildFile(filepath);
      } else {
        console.log(`[ferrum] buildAndWait: already building, just waiting`);
      }
    });
  }

  getDylibPath(moduleId) {
    const p = path.join(this.outputDir, `${moduleId}.dylib`);
    return fs.existsSync(p) ? p : null;
  }

  isBuilding(filepath) {
    return this.building.has(filepath);
  }

  stop() {
    // fs.watch handles are cleaned up by GC
    this._watcher = null;
  }
}

module.exports = CppDaemon;
