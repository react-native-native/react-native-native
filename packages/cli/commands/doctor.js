const { defineCommand } = require('citty');

module.exports = defineCommand({
  meta: { name: 'doctor', description: 'Check development environment for issues' },
  args: {
    platform: {
      type: 'string',
      description: 'Limit checks to a single platform (ios or android)',
    },
  },
  run({ args }) {
    // Make args available to the script via process.env
    if (args.platform) {
      process.argv.push('--platform', args.platform);
    }
    require('../scripts/doctor.js');
  },
});
