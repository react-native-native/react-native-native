/**
 * Universal Ferrum transformer — routes .rs, .cpp, .mm, .cc files
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
  return `ferrum.${name}`;
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
import FerrumContainer from '@react-native-native/nativ-fabric/src/FerrumContainerNativeComponent';

if (!global.__ferrum_loaded) global.__ferrum_loaded = {};

const ${displayName} = React.forwardRef((props, ref) => {
  const { style, children, ...nativeProps } = props;

  // Hot-reload: load dylib when source changes
  const hash = '${srcHash}';
  if (global.__ferrum_loaded['${moduleId}'] !== hash) {
    global.__ferrum_loaded['${moduleId}'] = hash;
    try {
      const { NativeModules } = require('react-native');
      const _scriptUrl = NativeModules?.SourceCode?.getConstants?.()?.scriptURL || '';
      const _host = _scriptUrl.match(/^https?:\\/\\/[^/]+/)?.[0] || '';
      if (_host && global.__rna?.loadDylib) {
        global.__rna.loadDylib(_host + '/__ferrum_dylib/ferrum_${moduleId}_' + hash + '.${_ext}');
      }
    } catch (e) {
      if (typeof __DEV__ !== 'undefined' && __DEV__) console.log('[ferrum] dylib load:', e?.message);
    }
  }

  // Store props in JSI — called on every render (React handles when to re-render)
  if (global.__rna?.setComponentProps) {
    global.__rna.setComponentProps('${componentId}', nativeProps);
  }

  // DEBUG: use Date.now() to guarantee unique propsJson every render
  // If numbers STILL stop, the issue is not in propsJson comparison
  const _pj = String(Date.now());

  return (
    <FerrumContainer
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
// No loadDylib, no __ferrum_loaded tracking, no Metro host URL.
// Functions are already registered at app start via constructors.

function cppFunctionShimProd(exports, moduleId) {
  const lines = [`import '@react-native-native/nativ-fabric';`, ''];
  for (const fn of exports) {
    const argNames = fn.args.map(a => a.name).join(', ');
    if (fn.async) {
      lines.push(
        `export function ${fn.name}(${argNames}) {`,
        `  const argsJson = JSON.stringify([${argNames}]);`,
        `  return new Promise((resolve, reject) => {`,
        `    try {`,
        `      const result = global.__rna.callSync('${moduleId}', '${fn.name}', argsJson);`,
        `      resolve(JSON.parse(result));`,
        `    } catch (e) { reject(e); }`,
        `  });`,
        `}`,
      );
    } else {
      lines.push(
        `export function ${fn.name}(${argNames}) {`,
        `  const argsJson = JSON.stringify([${argNames}]);`,
        `  const result = global.__rna.callSync('${moduleId}', '${fn.name}', argsJson);`,
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
import FerrumContainer from '@react-native-native/nativ-fabric/src/FerrumContainerNativeComponent';

const ${displayName} = React.forwardRef((props, ref) => {
  const { style, children, ...nativeProps } = props;

  if (global.__rna?.setComponentProps) {
    global.__rna.setComponentProps('${componentId}', nativeProps);
  }

  return (
    <FerrumContainer
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
  // Ensure @react-native-native/nativ-fabric is imported to trigger TurboModule load → installJSIBindings → global.__rna
  // Fast Refresh only swaps function bodies — so the hash check and dylib load
  // must be INSIDE each exported function as string literals.
  // global.__ferrum_loaded tracks which version is loaded per module.
  const loadSnippet = [
    `  if (!global.__ferrum_loaded) global.__ferrum_loaded = {};`,
    `  if (global.__ferrum_loaded['${_dylibId}'] !== '${srcHash}') {`,
    `    global.__ferrum_loaded['${_dylibId}'] = '${srcHash}';`,
    `    try {`,
    `      var _s = require('react-native').NativeModules?.SourceCode?.getConstants?.()?.scriptURL || '';`,
    `      var _h = (_s.match(/^https?:\\/\\/[^/]+/) || [''])[0];`,
    `      if (_h && global.__rna?.loadDylib) {`,
    `        global.__rna.loadDylib(_h + '/__ferrum_dylib/${_dylibId}_${srcHash}.${_ext}');`,
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
        `  return new Promise((resolve, reject) => {`,
        `    try {`,
        `      const result = global.__rna.callSync('${moduleId}', '${fn.name}', argsJson);`,
        `      resolve(JSON.parse(result));`,
        `    } catch (e) {`,
        `      reject(e);`,
        `    }`,
        `  });`,
        `}`,
      );
    } else {
      lines.push(
        `export function ${fn.name}(${argNames}) {`,
        loadSnippet,
        `  const argsJson = JSON.stringify([${argNames}]);`,
        `  const result = global.__rna.callSync('${moduleId}', '${fn.name}', argsJson);`,
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
  return `ferrum-transformer-${_sessionId}`;
};

module.exports.transform = async function ferrumTransform({
  filename,
  src,
  options,
  ...rest
}) {
  const projectRoot = options.projectRoot;
  const platform = options.platform || 'ios';
  const isAndroid = platform === 'android';
  const isDev = options.dev !== false;
  const isNative = filename.startsWith(projectRoot) &&
                   !filename.includes('node_modules') &&
                   !filename.includes('/packages/') &&
                   (filename.endsWith('.rs') || filename.endsWith('.cpp') ||
                   filename.endsWith('.cc') || filename.endsWith('.mm') ||
                   filename.endsWith('.swift') || filename.endsWith('.kt'));

  // Skip platform-incompatible files
  if (isAndroid && (filename.endsWith('.swift') || filename.endsWith('.mm'))) {
    return upstreamTransformer.transform({
      filename: filename.replace(/\.(swift|mm)$/, '.js'),
      src: 'export default undefined;\n',
      options, ...rest,
    });
  }
  if (!isAndroid && filename.endsWith('.kt')) {
    return upstreamTransformer.transform({
      filename: filename.replace(/\.kt$/, '.js'),
      src: 'export default undefined;\n',
      options, ...rest,
    });
  }

  if (isNative) {
    console.log(`[ferrum] transform (${platform}): ${path.basename(filename)} (build #${++_buildCounter})`);
  }

  // ── Content-addressed compile helper ──────────────────────────────────
  // Wraps any compiler call: if the hashed output exists, skip compile.
  // Compiler produces the original name, then we link/copy to the hashed name.
  function cachedCompile(srcContent, origName, ext, compileFn) {
    const hash = require('crypto').createHash('md5').update(srcContent).digest('hex').slice(0, 8);
    const hashedName = `${origName}_${hash}.${ext}`;
    const dylibDir = path.join(projectRoot, '.ferrum/dylibs');
    const hashedPath = path.join(dylibDir, hashedName);
    if (fs.existsSync(hashedPath)) {
      console.log(`[ferrum] ${origName} cache hit (${hash})`);
      return hash;
    }
    compileFn(); // run the actual compiler
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
      srcHash = cachedCompile(src, `ferrum_${baseName}`, libExt, () => {
        if (isAndroid) {
          compileAndroidRustDylib(filename, projectRoot);
        } else {
          compileRustDylib(filename, projectRoot);
        }
      });

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
          fs.writeFileSync(filename + '.d.ts', dts);
        } else if (functions.length > 0) {
          fs.writeFileSync(filename + '.d.ts', generateDTS(functions));
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
      const moduleId = `ferrum.${baseName}`;
      const fns = functions.map(f => ({ ...f, args: f.args.map(a => ({ ...a, type: a.tsType || a.type })) }));
      shimCode = isDev
        ? cppFunctionShim(fns, moduleId, srcHash, `ferrum_${baseName}`, _libExt)
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
    const isSwiftComponent = swiftSrc.includes('@rna_component') || swiftSrc.includes('ferrum::component');
    const moduleId = path.basename(filename, '.swift').toLowerCase();

    let srcHash = 'prod';
    if (isDev) {
      const origName = isSwiftComponent ? `ferrum_${moduleId}` : moduleId;
      srcHash = cachedCompile(src, origName, 'dylib', () => {
        compileSwiftDylib(filename, projectRoot);
      });
    }

    if (isSwiftComponent) {
      const componentId = `ferrum.${moduleId}`;
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
        fs.writeFileSync(filename + '.d.ts', lines.join('\n'));
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

    // Check if this is a component (RNA_COMPONENT / ferrum::component)
    const { isCppComponent, extractCppComponentProps } = require('./extractors/cpp-ast-extractor');
    if (isCppComponent(filename)) {
      const baseName = path.basename(filename).replace(/\.(cpp|cc|mm)$/, '').toLowerCase();
      const componentId = `ferrum.${baseName}`;

      let srcHash = 'prod';
      if (isDev) {
        const cppProps = extractCppComponentProps(filename);
        const _cppCompLibExt = isAndroid ? 'so' : 'dylib';
        srcHash = cachedCompile(src, `ferrum_${baseName}`, _cppCompLibExt, () => {
          if (isAndroid) {
            compileAndroidCppComponentDylib(filename, _includePaths, projectRoot, baseName, cppProps);
          } else {
            compileCppComponentDylib(filename, _includePaths, projectRoot, baseName, cppProps);
          }
        });

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
          fs.writeFileSync(filename + '.d.ts', dts);
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
      console.warn(`[ferrum] No RNA_EXPORT functions found in ${path.basename(filename)}`);
    }

    const moduleId = moduleIdForFile(filename, projectRoot);

    let srcHash = 'prod';
    if (isDev) {
      const _cppFnLibExt = isAndroid ? 'so' : 'dylib';
      srcHash = cachedCompile(src, moduleId, _cppFnLibExt, () => {
        if (exports.length > 0) {
          if (isAndroid) {
            compileAndroidCppDylib(filename, _includePaths, exports, projectRoot);
          } else {
            compileDylib(filename, _includePaths, exports, projectRoot);
          }
        }
      });

      try {
        fs.writeFileSync(filename + '.d.ts', generateDTS(exports));
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

      // Compile to .dex for Android (no-op on iOS — .kt is Android-only)
      if (isAndroid) {
        compileKotlinDex(filename, projectRoot);
      }

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
          fs.writeFileSync(filename + '.d.ts', dts);
        } else if (functions.length > 0) {
          const lines = ['// Auto-generated by React Native Native', ''];
          for (const fn of functions) {
            const args = fn.args.map(a => `${a.name}: ${a.tsType}`).join(', ');
            const ret = fn.async ? `Promise<${fn.tsType}>` : fn.tsType;
            lines.push(`export declare function ${fn.name}(${args}): ${ret};`);
          }
          lines.push('');
          fs.writeFileSync(filename + '.d.ts', lines.join('\n'));
        }
      } catch {}
    }

    let shimCode;
    if (isComponent) {
      const componentId = `ferrum.${moduleId}`;
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
