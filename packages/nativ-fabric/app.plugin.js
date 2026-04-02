/**
 * React Native Native — Expo config plugin.
 *
 * Patches:
 * - MainApplication.kt: FerrumBindingsInstaller + FerrumContainerPackage
 * - iOS: generates podspec in .ferrum/generated/ for static linking in release
 */

const { withMainApplication, withDangerousMod } = require('@expo/config-plugins');
const path = require('path');
const fs = require('fs');

function withReactNativeNative(config) {
  config = withMainApplicationPatch(config);
  config = withiOSPodspec(config);
  return config;
}

// ─── Android: MainApplication.kt ───────────────────────────────────────

function withMainApplicationPatch(config) {
  return withMainApplication(config, (config) => {
    config.modResults.contents = patchMainApplication(config.modResults.contents);
    return config;
  });
}

function patchMainApplication(src) {
  // FerrumContainerPackage registers view manager + RNARuntime TurboModule.
  // global.__rna is installed via TurboModuleWithJSIBindings — no BindingsInstaller needed.
  if (!src.includes('FerrumContainerPackage')) {
    src = src.replace(
      /PackageList\(this\)\.packages/,
      'PackageList(this).packages.apply {\n          add(com.ferrumfabric.FerrumContainerPackage())\n        }'
    );
  }

  return src;
}

// ─── iOS: Generate podspec in .ferrum/generated/ ───────────────────────

function withiOSPodspec(config) {
  return withDangerousMod(config, ['ios', (config) => {
    const projectRoot = config.modRequest.projectRoot;
    // Podspec at project root — CocoaPods requires source_files relative to podspec dir.
    // .gitignore this file.
    const podspecContent = `Pod::Spec.new do |s|
  s.name         = 'ReactNativeNativeUserCode'
  s.version      = '0.1.0'
  s.summary      = 'User native code for React Native Native'
  s.author       = 'Auto-generated'
  s.homepage     = 'https://reactnativenative.dev'
  s.license      = { type: 'MIT' }
  s.platforms    = { ios: '15.1' }
  s.source       = { path: '.' }
  s.static_framework = true

  s.dependency 'React-jsi'

  if ENV['CONFIGURATION'] == 'Release' || ENV['RNN_STATIC'] == '1'
    s.source_files = [
      '.ferrum/generated/bridges/ios/**/*.{cpp,mm,c,swift}',
      '*.swift',
      'src/**/*.swift',
    ]

    has_swift = !Dir.glob(File.join(__dir__, '*.swift')).empty? ||
                !Dir.glob(File.join(__dir__, 'src/**/*.swift')).empty?
    s.swift_version = '5.0' if has_swift

    s.vendored_libraries = '.ferrum/generated/release/libferrum_user.a'

    s.script_phases = [{
      name: 'Build Rust Components',
      script: 'cd "\${PODS_ROOT}/../.." && node node_modules/@react-native-native/nativ-fabric/metro/compilers/static-compiler.js --platform ios',
      execution_position: :before_compile,
    }]

    s.pod_target_xcconfig = {
      'OTHER_LDFLAGS' => '$(inherited) -lc++ -lresolv',
      'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
      'GCC_PREPROCESSOR_DEFINITIONS' => '$(inherited) FERRUM_RELEASE=1',
      'HEADER_SEARCH_PATHS' => '"$(PODS_ROOT)/../.." "$(PODS_ROOT)/../../node_modules/@react-native-native/nativ-fabric/metro"',
    }

    rust_lib = File.expand_path('.ferrum/generated/release/libferrum_user.a', __dir__)
    force_loads = '-force_load "$(PODS_CONFIGURATION_BUILD_DIR)/ReactNativeNativeUserCode/libReactNativeNativeUserCode.a"'
    force_loads += " -force_load \\\"#{rust_lib}\\\"" if File.exist?(rust_lib)
    s.user_target_xcconfig = {
      'OTHER_LDFLAGS' => "$(inherited) #{force_loads}",
    }
  else
    s.source_files = []
  end
end
`;
    fs.writeFileSync(path.join(projectRoot, 'ReactNativeNativeUserCode.podspec'), podspecContent);

    // Add pod to Podfile if not already present
    const podfilePath = path.join(projectRoot, 'ios/Podfile');
    if (fs.existsSync(podfilePath)) {
      let podfile = fs.readFileSync(podfilePath, 'utf8');
      if (!podfile.includes('ReactNativeNativeUserCode')) {
        podfile = podfile.replace(
          /(^\s*post_install)/m,
          `  pod 'ReactNativeNativeUserCode', path: '..'\n\n$1`
        );
        fs.writeFileSync(podfilePath, podfile);
      }
    }

    return config;
  }]);
}

module.exports = withReactNativeNative;
