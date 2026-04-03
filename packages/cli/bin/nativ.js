#!/usr/bin/env node

const { defineCommand, runMain } = require('citty');

const main = defineCommand({
  meta: { name: 'nativ', description: 'React Native Native CLI' },
  subCommands: {
    doctor: () => require('../commands/doctor.js'),
    setup: () => require('../commands/setup.js'),
    build: () => require('../commands/build.js'),
  },
});

runMain(main);
