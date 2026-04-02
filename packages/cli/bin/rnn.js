#!/usr/bin/env node

const command = process.argv[2];

switch (command) {
  case 'setup-compose':
    require('../scripts/setup-compose.js');
    break;
  default:
    console.log('Usage: npx @react-native-native/cli <command>');
    console.log('');
    console.log('Commands:');
    console.log('  setup-compose   Download Compose compiler toolchain for Jetpack Compose hot-reload');
    console.log('');
    console.log('Note: Basic Kotlin hot-reload works without setup (uses Gradle cache).');
    console.log('Only run setup-compose if you use @Composable components.');
    process.exit(1);
}
