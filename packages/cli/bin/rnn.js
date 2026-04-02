#!/usr/bin/env node

const command = process.argv[2];

switch (command) {
  case 'setup-kotlin':
    require('../scripts/setup-kotlin.js');
    break;
  case 'setup-compose':
    require('../scripts/setup-compose.js');
    break;
  default:
    console.log('Usage: npx @react-native-native/cli <command>');
    console.log('');
    console.log('Commands:');
    console.log('  setup-kotlin    Download Kotlin compiler for .kt hot-reload');
    console.log('  setup-compose   Download Compose toolchain for @Composable hot-reload (includes setup-kotlin)');
    console.log('');
    console.log('C++, ObjC++, Swift, and Rust need no setup.');
    process.exit(1);
}
