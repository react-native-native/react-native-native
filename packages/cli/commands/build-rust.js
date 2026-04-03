const { defineCommand } = require('citty');
const path = require('path');
const { execSync } = require('child_process');

module.exports = defineCommand({
  meta: { name: 'rust', description: 'Compile Rust to static libraries for production' },
  args: {
    platform: {
      type: 'string',
      description: 'Target platform (ios or android)',
      required: true,
    },
  },
  run({ args }) {
    const platform = args.platform;
    if (!['ios', 'android'].includes(platform)) {
      console.error('Error: --platform must be "ios" or "android"');
      process.exit(1);
    }

    const staticCompiler = path.resolve(
      require.resolve('@react-native-native/nativ-fabric/package.json'),
      '..', 'metro', 'compilers', 'static-compiler.js'
    );

    console.log(`Building Rust for ${platform}...\n`);

    try {
      execSync(`node "${staticCompiler}" --platform ${platform} --rust-only`, {
        stdio: 'inherit',
        cwd: process.cwd(),
      });
    } catch (e) {
      console.error(`\nRust build failed for ${platform}`);
      process.exit(1);
    }
  },
});
