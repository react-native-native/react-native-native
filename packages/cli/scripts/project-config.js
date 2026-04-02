/**
 * project-config.js — Patches project files for React Native Native.
 *
 * - Adds .nativ/ to nearest .gitignore
 * - Adds rootDirs to tsconfig.json for .d.ts resolution
 *
 * Called by `npx nativ setup` and individual setup commands.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function configureProject(projectRoot) {
  // ── .gitignore ──────────────────────────────────────────────────────
  try {
    let gitignorePath = null;
    let dir = projectRoot;
    let gitRoot = projectRoot;
    try {
      gitRoot = execSync('git rev-parse --show-toplevel', {
        encoding: 'utf8', stdio: 'pipe', cwd: projectRoot,
      }).trim();
    } catch {}

    while (dir.length >= gitRoot.length) {
      const candidate = path.join(dir, '.gitignore');
      if (fs.existsSync(candidate)) { gitignorePath = candidate; break; }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    if (!gitignorePath) gitignorePath = path.join(projectRoot, '.gitignore');

    const gitignore = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
    if (!gitignore.includes('.nativ')) {
      fs.appendFileSync(gitignorePath, '\n# React Native Native build cache\n.nativ/\n');
      console.log('✓ Added .nativ/ to .gitignore');
    }
  } catch {}

  // ── tsconfig.json ───────────────────────────────────────────────────
  try {
    const tsconfigPath = path.join(projectRoot, 'tsconfig.json');
    if (fs.existsSync(tsconfigPath)) {
      const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf8'));
      const rootDirs = tsconfig.compilerOptions?.rootDirs || [];
      if (!rootDirs.some(d => d.includes('.nativ/typings'))) {
        tsconfig.compilerOptions = tsconfig.compilerOptions || {};
        tsconfig.compilerOptions.rootDirs = ['.', '.nativ/typings'];
        fs.writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2) + '\n');
        console.log('✓ Added rootDirs to tsconfig.json');
      }
    }
  } catch {}
}

module.exports = { configureProject };
