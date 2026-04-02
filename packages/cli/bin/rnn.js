#!/usr/bin/env node

const command = process.argv[2];

switch (command) {
  case 'setup-kotlin':
    require('../scripts/setup-kotlin.js');
    break;
  default:
    console.log('Usage: npx @react-native-native/cli <command>');
    console.log('');
    console.log('Commands:');
    console.log('  setup-kotlin    Download Kotlin compiler + Compose toolchain for dev hot-reload');
    process.exit(1);
}
