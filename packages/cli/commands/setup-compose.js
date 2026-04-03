const { defineCommand } = require('citty');

module.exports = defineCommand({
  meta: { name: 'compose', description: 'Download Compose compiler toolchain (includes Kotlin)' },
  run() {
    require('../scripts/setup-compose.js');
  },
});
