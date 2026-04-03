const { defineCommand } = require('citty');

module.exports = defineCommand({
  meta: { name: 'kotlin', description: 'Download Kotlin compiler toolchain' },
  run() {
    require('../scripts/setup-kotlin.js');
  },
});
