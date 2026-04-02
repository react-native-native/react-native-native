#!/usr/bin/env node

const consola = require('consola');
const { execSync } = require('child_process');
const path = require('path');
const { configureProject } = require('./project-config');

async function main() {
  consola.box('React Native Native setup');

  // Configure project files (.gitignore, tsconfig)
  configureProject(process.cwd());

  const platforms = await consola.prompt('Which platforms?', {
    type: 'multiselect',
    options: ['ios', 'android'],
    initial: ['ios', 'android'],
    required: true,
  });
  if (typeof platforms === 'symbol') process.exit(0);

  const languages = await consola.prompt('Which languages?', {
    type: 'multiselect',
    options: [
      { value: 'cpp', label: 'C++ / ObjC++', hint: 'no setup needed' },
      { value: 'swift', label: 'Swift', hint: 'iOS only, no setup needed' },
      { value: 'rust', label: 'Rust', hint: 'installs targets + Cargo.toml' },
      { value: 'kotlin', label: 'Kotlin', hint: 'downloads compiler' },
      { value: 'compose', label: 'Jetpack Compose', hint: 'includes Kotlin' },
    ],
    required: true,
  });
  if (typeof languages === 'symbol') process.exit(0);

  const platformFlag = platforms.length === 1 ? `--platform ${platforms[0]}` : '';
  const scriptsDir = __dirname;

  if (languages.includes('rust')) {
    consola.start('Setting up Rust...');
    try {
      execSync(`node ${path.join(scriptsDir, 'setup-rust.js')} ${platformFlag}`, {
        stdio: 'inherit',
        cwd: process.cwd(),
      });
      consola.success('Rust ready');
    } catch {
      consola.error('Rust setup failed');
    }
  }

  if (languages.includes('compose')) {
    consola.start('Setting up Kotlin + Compose...');
    try {
      execSync(`node ${path.join(scriptsDir, 'setup-compose.js')}`, {
        stdio: 'inherit',
        cwd: process.cwd(),
      });
      consola.success('Kotlin + Compose ready');
    } catch {
      consola.error('Kotlin + Compose setup failed');
    }
  } else if (languages.includes('kotlin')) {
    consola.start('Setting up Kotlin...');
    try {
      execSync(`node ${path.join(scriptsDir, 'setup-kotlin.js')}`, {
        stdio: 'inherit',
        cwd: process.cwd(),
      });
      consola.success('Kotlin ready');
    } catch {
      consola.error('Kotlin setup failed');
    }
  }

  const noSetup = [];
  if (languages.includes('cpp')) noSetup.push('C++/ObjC++');
  if (languages.includes('swift')) noSetup.push('Swift');
  if (noSetup.length > 0) {
    consola.info(`${noSetup.join(' and ')} — no additional setup needed`);
  }

  const runDoctor = await consola.prompt('Run doctor to verify?', {
    type: 'confirm',
    initial: true,
  });
  if (runDoctor === true) {
    execSync(`node ${path.join(scriptsDir, 'doctor.js')} ${platformFlag}`, {
      stdio: 'inherit',
      cwd: process.cwd(),
    });
  }

  consola.success('Setup complete!');
}

main().catch(e => {
  consola.error('Setup failed:', e.message);
  process.exit(1);
});
