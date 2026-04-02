/**
 * React Native Native — Metro configuration wrapper.
 *
 * Usage in metro.config.js:
 *   const { withReactNativeNative } = require('./ferrum');
 *   module.exports = withReactNativeNative(getDefaultConfig(__dirname));
 */

const path = require('path');
const fs = require('fs');
const { startDaemon, stopDaemon } = require('./utils/kotlin-daemon');

// ── Lazy-loaded compilers (only loaded on first cache miss) ───────────
let _compilers = null;
function getCompilers() {
  if (_compilers) return _compilers;
  _compilers = {
    compileDylib: require('./compilers/dylib-compiler').compileDylib,
    compileCppComponentDylib: require('./compilers/dylib-compiler').compileCppComponentDylib,
    compileRustDylib: require('./compilers/rust-compiler').compileRustDylib,
    compileSwiftDylib: require('./compilers/swift-compiler').compileSwiftDylib,
    compileAndroidCppDylib: require('./compilers/android-compiler').compileAndroidCppDylib,
    compileAndroidCppComponentDylib: require('./compilers/android-compiler').compileAndroidCppComponentDylib,
    compileAndroidRustDylib: require('./compilers/android-compiler').compileAndroidRustDylib,
    compileKotlinDex: require('./compilers/kotlin-compiler').compileKotlinDex,
    extractCppExports: require('./extractors/cpp-ast-extractor').extractCppExports,
    extractCppComponentProps: require('./extractors/cpp-ast-extractor').extractCppComponentProps,
    getIncludePaths: require('./utils/include-resolver').getIncludePaths,
  };
  return _compilers;
}

function withReactNativeNative(config) {
  const projectRoot = config.projectRoot || process.cwd();
  fs.mkdirSync(path.join(projectRoot, '.nativ'), { recursive: true });


  // ── Detect initial build targets ────────────────────────────────────
  // iOS: booted simulator → 'simulator', otherwise 'device'
  // Updated by middleware when a different target connects.
  let iosTarget = 'device';
  try {
    const { execSync } = require('child_process');
    const simctl = execSync('xcrun simctl list devices booted 2>/dev/null',
      { encoding: 'utf8', timeout: 3000 });
    if (simctl.includes('Booted')) iosTarget = 'simulator';
  } catch {}
  fs.writeFileSync(path.join(projectRoot, '.nativ/ios-target'), iosTarget);
  fs.writeFileSync(path.join(projectRoot, '.nativ/android-target'), 'arm64-v8a');
  console.log(`[ferrum] Build targets: iOS=${iosTarget}, Android=arm64-v8a`);

  // ── Kotlin compiler daemon ───────────────────────────────────────────
  startDaemon(projectRoot);
  process.on('exit', stopDaemon);
  process.on('SIGINT', () => { stopDaemon(); process.exit(); });
  process.on('SIGTERM', () => { stopDaemon(); process.exit(); });

  // ── Source extensions ────────────────────────────────────────────────
  config.resolver.sourceExts.push('rs', 'cpp', 'cc', 'mm', 'swift', 'kt', 'java');

  // ── Transformer ──────────────────────────────────────────────────────
  config.transformer.babelTransformerPath = path.resolve(__dirname, 'transformer.js');

  // ── Platform-aware resolution ────────────────────────────────────────
  // .swift/.mm → iOS only, .kt/.java → Android only, .rs/.cpp → both.
  // Bare imports (./Counter) resolve without explicit extension.
  const origResolveRequest = config.resolver.resolveRequest;
  config.resolver.resolveRequest = (context, moduleName, platform) => {
    const defaultResolve = origResolveRequest || context.resolveRequest;

    if (moduleName.startsWith('.') && !path.extname(moduleName)) {
      const platformExts = {
        ios: ['swift', 'mm'],
        android: ['kt', 'java'],
      };
      const sharedExts = ['rs', 'cpp', 'cc'];
      const tryExts = [...(platformExts[platform] || []), ...sharedExts];

      for (const ext of tryExts) {
        try {
          return defaultResolve(context, `${moduleName}.${ext}`, platform);
        } catch {}
      }
    }

    return defaultResolve(context, moduleName, platform);
  };

  // ── Dylib serving middleware (on-demand compilation) ──────────────────
  // URL: /__nativ_dylib/{target}/{origName}_{hash}.{ext}
  // If the file doesn't exist, compile it using modules.json manifest.
  let _includePaths = null;
  const manifestPath = path.join(projectRoot, '.nativ/modules.json');

  function compileOnDemand(target, origName, requestedHash, ext) {
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { return; }
    const entry = manifest[origName];
    if (!entry || !fs.existsSync(entry.source)) return;

    // Verify source still matches requested hash — skip stale requests
    const currentSource = fs.readFileSync(entry.source, 'utf8');
    const currentHash = require('crypto').createHash('md5').update(currentSource).digest('hex').slice(0, 8);
    if (currentHash !== requestedHash) return; // source changed, request is stale

    const dylibDir = path.join(projectRoot, '.nativ/dylibs', target);
    const hashedPath = path.join(dylibDir, `${origName}_${currentHash}.${ext}`);
    if (fs.existsSync(hashedPath)) return; // already compiled for this version

    fs.mkdirSync(dylibDir, { recursive: true });
    const c = getCompilers();
    const isAndroid = ['arm64-v8a', 'armeabi-v7a', 'x86_64', 'x86'].includes(target);
    const opts = { target };

    console.log(`[ferrum] On-demand compile: ${origName} for ${target} (${entry.type})`);

    // Update last-known target so future transforms compile for this target
    const targetFile = path.join(projectRoot, `.nativ/${isAndroid ? 'android' : 'ios'}-target`);
    try { fs.writeFileSync(targetFile, target); } catch {}

    try {
      switch (entry.type) {
        case 'rust':
        case 'rust-component':
          if (isAndroid) c.compileAndroidRustDylib(entry.source, projectRoot, opts);
          else c.compileRustDylib(entry.source, projectRoot, opts);
          break;
        case 'swift':
        case 'swift-component':
          c.compileSwiftDylib(entry.source, projectRoot, opts);
          break;
        case 'cpp': {
          if (!_includePaths) _includePaths = c.getIncludePaths(projectRoot);
          const exports = c.extractCppExports(entry.source, _includePaths);
          if (isAndroid) c.compileAndroidCppDylib(entry.source, _includePaths, exports, projectRoot, opts);
          else c.compileDylib(entry.source, _includePaths, exports, projectRoot, opts);
          break;
        }
        case 'cpp-component': {
          if (!_includePaths) _includePaths = c.getIncludePaths(projectRoot);
          const props = c.extractCppComponentProps(entry.source);
          if (isAndroid) c.compileAndroidCppComponentDylib(entry.source, _includePaths, projectRoot, entry.baseName, props, opts);
          else c.compileCppComponentDylib(entry.source, _includePaths, projectRoot, entry.baseName, props, opts);
          break;
        }
        case 'kotlin':
        case 'kotlin-component':
          c.compileKotlinDex(entry.source, projectRoot);
          break;
        default:
          console.error(`[ferrum] Unknown module type: ${entry.type}`);
          return;
      }
    } catch (e) {
      console.error(`[ferrum] Compile failed for ${origName}: ${e.message}`);
      return;
    }

    // Copy compiler output to content-hashed filename
    const origPath = path.join(dylibDir, `${origName}.${ext}`);
    if (fs.existsSync(origPath) && !fs.existsSync(hashedPath)) {
      try { fs.copyFileSync(origPath, hashedPath); } catch {}
    }
  }

  const prevEnhance = config.server?.enhanceMiddleware;
  config.server = {
    ...config.server,
    enhanceMiddleware: (middleware, server) => {
      const base = prevEnhance ? prevEnhance(middleware, server) : middleware;
      return (req, res, next) => {
        if (req.url?.startsWith('/__nativ_dylib/')) {
          const urlPath = req.url.split('?')[0].replace('/__nativ_dylib/', '');
          const filePath = path.join(projectRoot, '.nativ/dylibs', urlPath);

          // Cache hit — serve immediately
          if (fs.existsSync(filePath)) {
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            fs.createReadStream(filePath).pipe(res);
            return;
          }

          // Cache miss — compile on-demand, then re-check
          // Parse: {target}/{origName}_{hash}.{ext}
          const parts = urlPath.split('/');
          if (parts.length === 2) {
            const target = parts[0];
            const m = parts[1].match(/^(.+)_([a-f0-9]{8})\.(dylib|so|dex)$/);
            if (m) {
              const [, origName, hash, ext] = m;
              compileOnDemand(target, origName, hash, ext);
              // Re-check: if source hash matched requested hash, file now exists
              if (fs.existsSync(filePath)) {
                res.setHeader('Content-Type', 'application/octet-stream');
                res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
                res.setHeader('Pragma', 'no-cache');
                fs.createReadStream(filePath).pipe(res);
                return;
              }
            }
          }

          res.statusCode = 404;
          res.end('not found: ' + urlPath);
          return;
        }
        base(req, res, next);
      };
    },
  };

  // ── Cache clear hook ─────────────────────────────────────────────────
  // When Metro's cache is cleared (--clear), also wipe compiled native artifacts.
  config.cacheStores = [
    ...(config.cacheStores || []),
    {
      get: async () => null,
      set: async () => {},
      clear: () => {
        const dylibDir = path.join(projectRoot, '.nativ/dylibs');
        try { fs.rmSync(dylibDir, { recursive: true }); } catch {}
        fs.mkdirSync(dylibDir, { recursive: true });
        console.log('[ferrum] Cleared compiled native cache (.nativ/dylibs/)');
      },
    },
  ];

  return config;
}

module.exports = { withReactNativeNative };
