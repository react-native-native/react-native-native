/**
 * React Native Native — Metro configuration wrapper.
 *
 * Usage in metro.config.js:
 *   const { withReactNativeNative } = require('./ferrum');
 *   module.exports = withReactNativeNative(getDefaultConfig(__dirname));
 */

const path = require('path');
const fs = require('fs');
const { startDaemon, stopDaemon } = require('./kotlin-daemon');

function withReactNativeNative(config) {
  const projectRoot = config.projectRoot || process.cwd();

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

  // ── Dylib serving middleware ─────────────────────────────────────────
  const prevEnhance = config.server?.enhanceMiddleware;
  config.server = {
    ...config.server,
    enhanceMiddleware: (middleware, server) => {
      const base = prevEnhance ? prevEnhance(middleware, server) : middleware;
      return (req, res, next) => {
        if (req.url?.startsWith('/__ferrum_dylib/')) {
          const urlPath = req.url.split('?')[0].replace('/__ferrum_dylib/', '');
          const filePath = path.join(projectRoot, '.ferrum/dylibs', urlPath);
          if (fs.existsSync(filePath)) {
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            fs.createReadStream(filePath).pipe(res);
            return;
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
        const dylibDir = path.join(projectRoot, '.ferrum/dylibs');
        try { fs.rmSync(dylibDir, { recursive: true }); } catch {}
        fs.mkdirSync(dylibDir, { recursive: true });
        console.log('[ferrum] Cleared compiled native cache (.ferrum/dylibs/)');
      },
    },
  ];

  return config;
}

module.exports = { withReactNativeNative };
