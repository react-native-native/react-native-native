const { defineCommand } = require('citty');

module.exports = defineCommand({
  meta: { name: 'setup', description: 'Set up language toolchains' },
  args: {
    platform: {
      type: 'string',
      description: 'Limit to a single platform (ios or android)',
    },
  },
  subCommands: {
    rust: () => require('./setup-rust.js'),
    kotlin: () => require('./setup-kotlin.js'),
    compose: () => require('./setup-compose.js'),
  },
  async run({ rawArgs }) {
    // Only run interactive wizard when no subcommand given
    const sub = rawArgs.find(a => ['rust', 'kotlin', 'compose'].includes(a));
    if (!sub) require('../scripts/setup.js');
  },
});
