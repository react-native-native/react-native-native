const { defineCommand } = require('citty');

module.exports = defineCommand({
  meta: { name: 'rust', description: 'Install Rust targets + create Cargo.toml' },
  args: {
    platform: {
      type: 'string',
      description: 'Limit to a single platform (ios or android)',
    },
  },
  run({ args }) {
    if (args.platform) process.argv.push('--platform', args.platform);
    require('../scripts/setup-rust.js');
  },
});
