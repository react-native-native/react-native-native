const { defineCommand } = require('citty');

module.exports = defineCommand({
  meta: { name: 'build', description: 'Prebuild native libraries for production' },
  subCommands: {
    rust: () => require('./build-rust.js'),
  },
});
