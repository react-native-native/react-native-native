/**
 * Generates compile_commands.json for clangd IDE support.
 *
 * Called once when the Metro transformer first encounters a C++/ObjC++ file.
 * Discovers all .cpp/.cc/.mm/.c files in the project (excluding node_modules,
 * Pods, .ferrum) and writes a compile_commands.json at the project root so
 * clangd picks up the correct include paths, language standard, and sysroot.
 */

const fs = require('fs');
const path = require('path');

function findNativeFiles(projectRoot) {
  const results = [];
  const ignore = new Set(['node_modules', 'ios', 'android', '.ferrum', '.git', 'build']);

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.ferrum') continue;
      if (ignore.has(entry.name) && dir === projectRoot) continue;

      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // Don't recurse into ignored dirs at any level
        if (entry.name === 'node_modules' || entry.name === 'Pods') continue;
        walk(full);
      } else if (/\.(cpp|cc|mm|c|h|hpp)$/.test(entry.name)) {
        results.push(full);
      }
    }
  }

  walk(projectRoot);
  return results;
}

function generateCompileCommands(projectRoot, includePaths) {
  const files = findNativeFiles(projectRoot);
  if (files.length === 0) return;

  const entries = files
    .filter(f => /\.(cpp|cc|mm|c)$/.test(f)) // only source files, not headers
    .map(file => {
      const isObjCpp = file.endsWith('.mm');
      const isC = file.endsWith('.c');
      const lang = isObjCpp ? 'objective-c++' : isC ? 'c' : 'c++';

      const args = [
        'clang++',
        '-x', lang,
        '-std=c++17',
        '-arch', 'arm64',
      ];

      // ObjC++ files need the iOS SDK sysroot for UIKit/Foundation headers.
      // Pure C++ files work better without it (host stdlib).
      if (isObjCpp) {
        args.push(...includePaths);
        args.push('-fmodules');
      } else {
        // Strip -isysroot for pure C++ (use host headers)
        for (let i = 0; i < includePaths.length; i++) {
          if (includePaths[i] === '-isysroot') { i++; continue; }
          args.push(includePaths[i]);
        }
      }

      args.push('-c', file);

      return {
        directory: projectRoot,
        file: file,
        arguments: args,
      };
    });

  const outPath = path.join(projectRoot, 'compile_commands.json');
  const json = JSON.stringify(entries, null, 2);

  // Only write if changed (avoid triggering unnecessary clangd restarts)
  try {
    const existing = fs.readFileSync(outPath, 'utf8');
    if (existing === json) return;
  } catch {
    // File doesn't exist yet
  }

  fs.writeFileSync(outPath, json);
  console.log(`[ferrum] Generated compile_commands.json (${entries.length} files)`);
}

module.exports = { generateCompileCommands };
