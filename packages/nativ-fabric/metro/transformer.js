/**
 * Universal Nativ transformer — routes .rs, .cpp, .mm, .cc files
 * to the appropriate handler. All other files go to the default Expo
 * Babel transformer.
 */

const path = require('path');
const fs = require('fs');
const { extractCppExports } = require('./extractors/cpp-ast-extractor');
const { extractRustExports } = require('./extractors/rust-extractor');
const { generateDTS } = require('./utils/dts-generator');
const { getIncludePaths } = require('./utils/include-resolver');
const { generateCompileCommands } = require('./utils/compile-commands');
const { compileDylib, compileCppComponentDylib } = require('./compilers/dylib-compiler');
const { compileRustDylib } = require('./compilers/rust-compiler');
const { compileAndroidCppDylib, compileAndroidCppComponentDylib, compileAndroidRustDylib } = require('./compilers/android-compiler');
const { compileKotlinDex, extractKotlinExports } = require('./compilers/kotlin-compiler');

// Resolve the default Expo transformer. Since this file lives in the package
// (not the app), we resolve from process.cwd() which is the app root.
let upstreamTransformer;
try {
  const mc = require(require.resolve('expo/metro-config', { paths: [process.cwd()] }));
  const cfg = mc.getDefaultConfig(process.cwd());
  upstreamTransformer = require(cfg.transformer.babelTransformerPath);
} catch {
  upstreamTransformer = require(require.resolve(
    '@expo/metro-config/babel-transformer',
    { paths: [process.cwd()] }
  ));
}

// Cached per Metro session
let _includePaths = null;
let _buildCounter = 0;

// ─── Rust component shim ──────────────────────────────────────────────

function componentIdForFile(filename) {
  const name = path.basename(filename, '.rs').toLowerCase();
  return `nativ.${name}`;
}

function rustComponentShim(componentId, srcHash, libExt) {
  const displayName = componentId.split('.').pop();
  const moduleId = componentId.split('.').pop().toLowerCase();
  const _ext = libExt || 'dylib';
  // Fast Refresh swaps function bodies but keeps module-level vars.
  // So we put the hash as a literal inside the function body — when FR
  // patches the function, the new hash is baked into the new body.
  return `
import React from 'react';
import NativContainer from '@react-native-native/nativ-fabric/src/NativContainerNativeComponent';

if (!global.__nativ_loaded) global.__nativ_loaded = {};

const ${displayName} = React.forwardRef((props, ref) => {
  const { style, children, ...nativeProps } = props;

  // Hot-reload: load dylib when source changes
  const hash = '${srcHash}';
  if (global.__nativ_loaded['${moduleId}'] !== hash) {
    global.__nativ_loaded['${moduleId}'] = hash;
    try {
      const { NativeModules } = require('react-native');
      const _scriptUrl = NativeModules?.SourceCode?.getConstants?.()?.scriptURL || '';
      const _host = _scriptUrl.match(/^https?:\\/\\/[^/]+/)?.[0] || '';
      if (_host && global.__nativ?.loadDylib) {
        const _t = global.__nativ.target || '';
        global.__nativ.loadDylib(_host + '/__nativ_dylib/' + _t + '/nativ_${moduleId}_' + hash + '.${_ext}');
      }
    } catch (e) {
      if (typeof __DEV__ !== 'undefined' && __DEV__) console.log('[nativ] dylib load:', e?.message);
    }
  }

  // Store props in JSI — called on every render (React handles when to re-render)
  if (global.__nativ?.setComponentProps) {
    global.__nativ.setComponentProps('${componentId}', nativeProps);
  }

  // DEBUG: use Date.now() to guarantee unique propsJson every render
  // If numbers STILL stop, the issue is not in propsJson comparison
  const _pj = String(Date.now());

  return (
    <NativContainer
      style={style}
      ref={ref}
      key={'${srcHash}'}
      componentId="${componentId}"
      propsJson={_pj}
    />
  );
});
${displayName}.displayName = '${displayName}';

export default ${displayName};
export { ${displayName} };
`;
}

// ─── Production shims ─────────────────────────────────────────────────
// In release builds (dev: false), all native code is statically linked.
// No loadDylib, no __nativ_loaded tracking, no Metro host URL.
// Functions are already registered at app start via constructors.

function cppFunctionShimProd(exports, moduleId) {
  const lines = [`import '@react-native-native/nativ-fabric';`, ''];
  for (const fn of exports) {
    const argNames = fn.args.map(a => a.name).join(', ');
    if (fn.async) {
      lines.push(
        `export function ${fn.name}(${argNames}) {`,
        `  const argsJson = JSON.stringify([${argNames}]);`,
        `  return global.__nativ.callAsync('${moduleId}', '${fn.name}', argsJson);`,
        `}`,
      );
    } else {
      lines.push(
        `export function ${fn.name}(${argNames}) {`,
        `  const argsJson = JSON.stringify([${argNames}]);`,
        `  const result = global.__nativ.callSync('${moduleId}', '${fn.name}', argsJson);`,
        `  return JSON.parse(result);`,
        `}`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}

function rustComponentShimProd(componentId) {
  const displayName = componentId.split('.').pop();
  return `
import React from 'react';
import NativContainer from '@react-native-native/nativ-fabric/src/NativContainerNativeComponent';

const ${displayName} = React.forwardRef((props, ref) => {
  const { style, children, ...nativeProps } = props;

  if (global.__nativ?.setComponentProps) {
    global.__nativ.setComponentProps('${componentId}', nativeProps);
  }

  return (
    <NativContainer
      style={style}
      ref={ref}
      componentId="${componentId}"
      propsJson={JSON.stringify(nativeProps)}
    />
  );
});
${displayName}.displayName = '${displayName}';

export default ${displayName};
export { ${displayName} };
`;
}

// ─── C++/ObjC++ function shim ─────────────────────────────────────────

function moduleIdForFile(filename, projectRoot) {
  const rel = path.relative(projectRoot, filename);
  return rel
    .replace(/\.(cpp|cc|mm|c)$/, '')
    .replace(/[\/\\]/g, '_')
    .replace(/[^a-zA-Z0-9_]/g, '_');
}

function cppFunctionShim(exports, moduleId, srcHash, dylibId, libExt) {
  const _dylibId = dylibId || moduleId;
  const _ext = libExt || 'dylib';
  // Ensure @react-native-native/nativ-fabric is imported to trigger TurboModule load → installJSIBindings → global.__nativ
  // Fast Refresh only swaps function bodies — so the hash check and dylib load
  // must be INSIDE each exported function as string literals.
  // global.__nativ_loaded tracks which version is loaded per module.
  const loadSnippet = [
    `  if (!global.__nativ_loaded) global.__nativ_loaded = {};`,
    `  if (global.__nativ_loaded['${_dylibId}'] !== '${srcHash}') {`,
    `    global.__nativ_loaded['${_dylibId}'] = '${srcHash}';`,
    `    try {`,
    `      var _s = require('react-native').NativeModules?.SourceCode?.getConstants?.()?.scriptURL || '';`,
    `      var _h = (_s.match(/^https?:\\/\\/[^/]+/) || [''])[0];`,
    `      var _t = global.__nativ?.target || '';`,
    `      if (_h && global.__nativ?.loadDylib) {`,
    `        global.__nativ.loadDylib(_h + '/__nativ_dylib/' + _t + '/${_dylibId}_${srcHash}.${_ext}');`,
    `      }`,
    `    } catch(e) {}`,
    `  }`,
  ].join('\n');

  const lines = [`import '@react-native-native/nativ-fabric';`, ''];

  for (const fn of exports) {
    const argNames = fn.args.map(a => a.name).join(', ');

    if (fn.async) {
      lines.push(
        `export function ${fn.name}(${argNames}) {`,
        loadSnippet,
        `  const argsJson = JSON.stringify([${argNames}]);`,
        `  return global.__nativ.callAsync('${moduleId}', '${fn.name}', argsJson);`,
        `}`,
      );
    } else {
      lines.push(
        `export function ${fn.name}(${argNames}) {`,
        loadSnippet,
        `  const argsJson = JSON.stringify([${argNames}]);`,
        `  const result = global.__nativ.callSync('${moduleId}', '${fn.name}', argsJson);`,
        `  return JSON.parse(result);`,
        `}`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ─── Transform entry point ────────────────────────────────────────────

// Content-addressed caching: same source → same hash → same JS shim.
// Metro's SHA1 cache naturally deduplicates. Undo (A→B→A) serves the
// cached shim for A, which references the correct binary (also hashed).
const _sessionId = Date.now().toString(36);
module.exports.getCacheKey = function () {
  return `nativ-transformer-${_sessionId}`;
};

module.exports.transform = async function nativTransform({
  filename,
  src,
  options,
  ...rest
}) {
  const projectRoot = options.projectRoot;
  const platform = options.platform || 'ios';
  const isAndroid = platform === 'android';
  const isDev = options.dev !== false;

  // Read last-known target (written at startup + updated by middleware on device switch)
  let buildTarget;
  try {
    const targetFile = path.join(projectRoot, `.nativ/${isAndroid ? 'android' : 'ios'}-target`);
    buildTarget = fs.readFileSync(targetFile, 'utf8').trim();
  } catch {}
  if (!buildTarget) buildTarget = isAndroid ? 'arm64-v8a' : 'device';

  const isNative = filename.startsWith(projectRoot) &&
                   !filename.includes('node_modules') &&
                   !filename.includes('/packages/') &&
                   (filename.endsWith('.rs') || filename.endsWith('.cpp') ||
                   filename.endsWith('.cc') || filename.endsWith('.mm') ||
                   filename.endsWith('.swift') || filename.endsWith('.kt'));

  // Skip platform-incompatible files (but still generate .d.ts for IDE)
  if (isAndroid && (filename.endsWith('.swift') || filename.endsWith('.mm'))) {
    if (isDev && filename.endsWith('.swift')) {
      try {
        const { extractSwiftExports } = require('./compilers/swift-compiler');
        const swExports = extractSwiftExports(filename);
        if (swExports.length > 0) {
          const lines = ['// Auto-generated by React Native Native', ''];
          for (const fn of swExports) {
            lines.push(`export declare function ${fn.name}(): ${fn.async ? 'Promise<string>' : 'string'};`);
          }
          lines.push('');
          fs.writeFileSync(dtsPath(filename), lines.join('\n'));
        }
      } catch {}
    }
    return upstreamTransformer.transform({
      filename: filename.replace(/\.(swift|mm)$/, '.js'),
      src: 'export default undefined;\n',
      options, ...rest,
    });
  }
  if (!isAndroid && filename.endsWith('.kt')) {
    // Still generate .d.ts for IDE support even on iOS
    if (isDev) {
      try {
        const { functions: ktFns, isComponent: ktIsComp, componentProps: ktProps } = extractKotlinExports(filename);
        const ktBaseName = path.basename(filename, '.kt');
        if (ktIsComp) {
          const propsLines = ktProps.filter(p => !p.isCallback).map(p => `  ${p.jsName}?: ${p.tsType};`);
          const cbLines = ktProps.filter(p => p.isCallback).map(p => `  ${p.jsName}?: () => void;`);
          fs.writeFileSync(dtsPath(filename), [
            `import type { ViewProps } from 'react-native';`, '',
            `interface ${ktBaseName}Props extends ViewProps {`, ...propsLines, ...cbLines, `}`, '',
            `declare const ${ktBaseName}: React.ComponentType<${ktBaseName}Props>;`,
            `export default ${ktBaseName};`, `export { ${ktBaseName} };`, '',
          ].join('\n'));
        } else if (ktFns.length > 0) {
          const lines = ['// Auto-generated by React Native Native', ''];
          for (const fn of ktFns) {
            const args = fn.args.map(a => `${a.name}: ${a.tsType}`).join(', ');
            lines.push(`export declare function ${fn.name}(${args}): ${fn.tsType};`);
          }
          lines.push('');
          fs.writeFileSync(dtsPath(filename), lines.join('\n'));
        }
      } catch {}
    }
    return upstreamTransformer.transform({
      filename: filename.replace(/\.kt$/, '.js'),
      src: 'export default undefined;\n',
      options, ...rest,
    });
  }

  if (isNative) {
    console.log(`[nativ] transform (${platform}): ${path.basename(filename)} (build #${++_buildCounter})`);
  }

  // ── .d.ts output path ────────────────────────────────────────────────
  // Write typings to .nativ/typings/, stripping native extension.
  // tsconfig rootDirs: [".", ".nativ/typings"] makes TS find them.
  // e.g. math_utils.cpp → .nativ/typings/math_utils.d.ts
  function dtsPath(sourceFile) {
    const rel = path.relative(projectRoot, sourceFile);
    const dtsRel = rel.replace(/\.(rs|cpp|cc|mm|c|swift|kt)$/, '.d.ts');
    const out = path.join(projectRoot, '.nativ/typings', dtsRel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    return out;
  }

  // ── Content-addressed compile + manifest ─────────────────────────────
  // Compiles for the last-known target (single flash hot-reload).
  // Also writes manifest so the middleware can compile on-demand for other targets.
  const manifestPath = path.join(projectRoot, '.nativ/modules.json');
  function writeManifest(dylibName, entry) {
    let manifest = {};
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch {}
    manifest[dylibName] = entry;
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }

  function cachedCompile(srcContent, origName, ext, compileFn) {
    const hash = require('crypto').createHash('md5').update(srcContent).digest('hex').slice(0, 8);
    const hashedName = `${origName}_${hash}.${ext}`;
    const dylibDir = path.join(projectRoot, '.nativ/dylibs', buildTarget);
    fs.mkdirSync(dylibDir, { recursive: true });
    const hashedPath = path.join(dylibDir, hashedName);
    if (fs.existsSync(hashedPath)) {
      console.log(`[nativ] ${origName} cache hit (${hash}, ${buildTarget})`);
      return hash;
    }
    compileFn(); // compile for last-known target
    const origPath = path.join(dylibDir, `${origName}.${ext}`);
    if (fs.existsSync(origPath)) {
      try { fs.copyFileSync(origPath, hashedPath); } catch {}
    }
    return hash;
  }

  // ── Rust files → component or function shim
  if (filename.endsWith('.rs')) {
    const { functions, isComponent, componentProps } = extractRustExports(filename);
    const baseName = path.basename(filename, '.rs').toLowerCase();

    let srcHash = 'prod';
    if (isDev) {
      const libExt = isAndroid ? 'so' : 'dylib';
      srcHash = cachedCompile(src, `nativ_${baseName}`, libExt, () => {
        if (isAndroid) compileAndroidRustDylib(filename, projectRoot, { target: buildTarget });
        else compileRustDylib(filename, projectRoot, { target: buildTarget });
      });
      writeManifest(`nativ_${baseName}`, { source: filename, type: isComponent ? 'rust-component' : 'rust' });
      // Generate .d.ts for TypeScript support
      try {
        if (isComponent) {
          const displayName = path.basename(filename, '.rs');
          const propsLines = componentProps.map(p => `  ${p.jsName}?: ${p.tsType};`);
          const dts = [
            `import type { ViewProps } from 'react-native';`,
            ``,
            `interface ${displayName}Props extends ViewProps {`,
            ...propsLines,
            `}`,
            ``,
            `declare const ${displayName}: React.ComponentType<${displayName}Props>;`,
            `export default ${displayName};`,
            `export { ${displayName} };`,
            ``,
          ].join('\n');
          fs.writeFileSync(dtsPath(filename), dts);
        } else if (functions.length > 0) {
          fs.writeFileSync(dtsPath(filename), generateDTS(functions));
        }
      } catch {}
    }

    const _libExt = isAndroid ? 'so' : 'dylib';
    let shimCode;
    if (isComponent) {
      const componentId = componentIdForFile(filename);
      shimCode = isDev
        ? rustComponentShim(componentId, srcHash, _libExt)
        : rustComponentShimProd(componentId);
    } else if (functions.length > 0) {
      const moduleId = `nativ.${baseName}`;
      const fns = functions.map(f => ({ ...f, args: f.args.map(a => ({ ...a, type: a.tsType || a.type })) }));
      shimCode = isDev
        ? cppFunctionShim(fns, moduleId, srcHash, `nativ_${baseName}`, _libExt)
        : cppFunctionShimProd(fns, moduleId);
    } else {
      shimCode = `// ${path.basename(filename)}: no exports found\nexport {};\n`;
    }

    return upstreamTransformer.transform({
      filename: filename.replace(/\.rs$/, '.js'),
      src: shimCode,
      options,
      ...rest,
    });
  }

  // ── Swift files → function or component shim
  if (filename.endsWith('.swift')) {
    const { compileSwiftDylib, extractSwiftExports } = require('./compilers/swift-compiler');

    const swiftSrc = fs.readFileSync(filename, 'utf8');
    const isSwiftComponent = swiftSrc.includes('@nativ_component') || swiftSrc.includes('nativ::component');
    const moduleId = path.basename(filename, '.swift').toLowerCase();

    let srcHash = 'prod';
    if (isDev) {
      const origName = isSwiftComponent ? `nativ_${moduleId}` : moduleId;
      srcHash = cachedCompile(src, origName, 'dylib', () => {
        compileSwiftDylib(filename, projectRoot, { target: buildTarget });
      });
      writeManifest(origName, { source: filename, type: isSwiftComponent ? 'swift-component' : 'swift' });
    }

    if (isSwiftComponent) {
      const componentId = `nativ.${moduleId}`;
      const shimCode = isDev
        ? rustComponentShim(componentId, srcHash)
        : rustComponentShimProd(componentId);
      return upstreamTransformer.transform({
        filename: filename.replace(/\.swift$/, '.js'),
        src: shimCode,
        options,
        ...rest,
      });
    }

    const exports = extractSwiftExports(filename);

    if (isDev) {
      try {
        const lines = ['// Auto-generated by React Native Native', ''];
        for (const fn of exports) {
          lines.push(`export declare function ${fn.name}(): ${fn.async ? 'Promise<string>' : 'string'};`);
        }
        lines.push('');
        fs.writeFileSync(dtsPath(filename), lines.join('\n'));
      } catch {}
    }

    const fns = exports.map(fn => ({ name: fn.name, async: fn.async, args: [] }));
    const shimCode = isDev
      ? cppFunctionShim(fns, moduleId, srcHash, moduleId)
      : cppFunctionShimProd(fns, moduleId);

    return upstreamTransformer.transform({
      filename: filename.replace(/\.swift$/, '.js'),
      src: shimCode,
      options,
      ...rest,
    });
  }

  // ── C++/ObjC++ files → function export shim or component
  const isCpp = filename.endsWith('.cpp') || filename.endsWith('.cc');
  const isObjCpp = filename.endsWith('.mm');

  if (isCpp || isObjCpp) {
    // Resolve include paths once + generate compile_commands.json for clangd
    if (isDev && !_includePaths) {
      _includePaths = getIncludePaths(projectRoot);
      generateCompileCommands(projectRoot, _includePaths);
    }

    // Check if this is a component (NATIV_COMPONENT / nativ::component)
    const { isCppComponent, extractCppComponentProps } = require('./extractors/cpp-ast-extractor');
    if (isCppComponent(filename)) {
      const baseName = path.basename(filename).replace(/\.(cpp|cc|mm)$/, '').toLowerCase();
      const componentId = `nativ.${baseName}`;

      let srcHash = 'prod';
      const cppProps = extractCppComponentProps(filename);
      if (isDev) {
        const _cppCompLibExt = isAndroid ? 'so' : 'dylib';
        srcHash = cachedCompile(src, `nativ_${baseName}`, _cppCompLibExt, () => {
          if (isAndroid) compileAndroidCppComponentDylib(filename, _includePaths, projectRoot, baseName, cppProps, { target: buildTarget });
          else compileCppComponentDylib(filename, _includePaths, projectRoot, baseName, cppProps, { target: buildTarget });
        });
        writeManifest(`nativ_${baseName}`, { source: filename, type: 'cpp-component', baseName });

        try {
          const displayName = path.basename(filename).replace(/\.(cpp|cc|mm)$/, '');
          const propsLines = cppProps.map(p => `  ${p.jsName}?: ${p.tsType};`);
          const dts = [
            `import type { ViewProps } from 'react-native';`,
            ``,
            `interface ${displayName}Props extends ViewProps {`,
            ...propsLines,
            `}`,
            ``,
            `declare const ${displayName}: React.ComponentType<${displayName}Props>;`,
            `export default ${displayName};`,
            `export { ${displayName} };`,
            ``,
          ].join('\n');
          fs.writeFileSync(dtsPath(filename), dts);
        } catch {}
      }

      const _cppLibExt = isAndroid ? 'so' : 'dylib';
      const shimCode = isDev
        ? rustComponentShim(componentId, srcHash, _cppLibExt)
        : rustComponentShimProd(componentId);

      return upstreamTransformer.transform({
        filename: filename.replace(/\.(cpp|cc|mm)$/, '.js'),
        src: shimCode,
        options,
        ...rest,
      });
    }

    // Extract exported functions
    const exports = extractCppExports(filename, _includePaths);

    if (isDev && exports.length === 0) {
      console.warn(`[nativ] No NATIV_EXPORT functions found in ${path.basename(filename)}`);
    }

    const moduleId = moduleIdForFile(filename, projectRoot);

    let srcHash = 'prod';
    if (isDev) {
      const _cppFnLibExt = isAndroid ? 'so' : 'dylib';
      srcHash = cachedCompile(src, moduleId, _cppFnLibExt, () => {
        if (exports.length > 0) {
          if (isAndroid) compileAndroidCppDylib(filename, _includePaths, exports, projectRoot, { target: buildTarget });
          else compileDylib(filename, _includePaths, exports, projectRoot, { target: buildTarget });
        }
      });
      writeManifest(moduleId, { source: filename, type: 'cpp' });

      try {
        fs.writeFileSync(dtsPath(filename), generateDTS(exports));
      } catch {}
    }

    const shimCode = isDev
      ? cppFunctionShim(exports, moduleId, srcHash, null, isAndroid ? 'so' : 'dylib')
      : cppFunctionShimProd(exports, moduleId);

    return upstreamTransformer.transform({
      filename: filename.replace(/\.(cpp|cc|mm)$/, '.js'),
      src: shimCode,
      options,
      ...rest,
    });
  }

  // ── Kotlin files → function or component shim
  if (filename.endsWith('.kt')) {
    const { functions, isComponent, componentProps } = extractKotlinExports(filename);
    const baseName = path.basename(filename, '.kt');
    const moduleId = baseName.toLowerCase();

    let srcHash = 'prod';
    if (isDev) {
      srcHash = require('crypto').createHash('md5').update(src).digest('hex').slice(0, 8);
      if (isAndroid) {
        compileKotlinDex(filename, projectRoot);
      }
      writeManifest(moduleId, { source: filename, type: isComponent ? 'kotlin-component' : 'kotlin' });

      // Generate .d.ts
      try {
        if (isComponent) {
          const propsLines = componentProps
            .filter(p => !p.isCallback)
            .map(p => `  ${p.jsName}?: ${p.tsType};`);
          const cbLines = componentProps
            .filter(p => p.isCallback)
            .map(p => `  ${p.jsName}?: () => void;`);
          const dts = [
            `import type { ViewProps } from 'react-native';`,
            ``,
            `interface ${baseName}Props extends ViewProps {`,
            ...propsLines,
            ...cbLines,
            `}`,
            ``,
            `declare const ${baseName}: React.ComponentType<${baseName}Props>;`,
            `export default ${baseName};`,
            `export { ${baseName} };`,
            ``,
          ].join('\n');
          fs.writeFileSync(dtsPath(filename), dts);
        } else if (functions.length > 0) {
          const lines = ['// Auto-generated by React Native Native', ''];
          for (const fn of functions) {
            const args = fn.args.map(a => `${a.name}: ${a.tsType}`).join(', ');
            const ret = fn.async ? `Promise<${fn.tsType}>` : fn.tsType;
            lines.push(`export declare function ${fn.name}(${args}): ${ret};`);
          }
          lines.push('');
          fs.writeFileSync(dtsPath(filename), lines.join('\n'));
        }
      } catch {}
    }

    let shimCode;
    if (isComponent) {
      const componentId = `nativ.${moduleId}`;
      shimCode = isDev
        ? rustComponentShim(componentId, srcHash, 'dex')
        : rustComponentShimProd(componentId);
    } else if (functions.length > 0) {
      const fns = functions.map(f => ({ ...f, args: f.args.map(a => ({ ...a, type: a.tsType })) }));
      shimCode = isDev
        ? cppFunctionShim(fns, moduleId, srcHash, moduleId, 'dex')
        : cppFunctionShimProd(fns, moduleId);
    } else {
      shimCode = `// ${baseName}.kt: no exports found\nexport {};\n`;
    }

    return upstreamTransformer.transform({
      filename: filename.replace(/\.kt$/, '.js'),
      src: shimCode,
      options,
      ...rest,
    });
  }

  // ── All other files → upstream Babel
  return upstreamTransformer.transform({ filename, src, options, ...rest });
};
