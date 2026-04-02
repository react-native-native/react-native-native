Pod::Spec.new do |s|
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
      '.nativ/generated/bridges/ios/**/*.{cpp,mm,c,swift}',
      '*.swift',
      'src/**/*.swift',
    ]

    has_swift = !Dir.glob(File.join(__dir__, '*.swift')).empty? ||
                !Dir.glob(File.join(__dir__, 'src/**/*.swift')).empty?
    s.swift_version = '5.0' if has_swift

    s.vendored_libraries = '.nativ/generated/release/libferrum_user.a'

    s.script_phases = [{
      name: 'Build Rust Components',
      script: 'cd "${PODS_ROOT}/../.." && node ferrum/static-compiler.js --platform ios',
      execution_position: :before_compile,
    }]

    s.pod_target_xcconfig = {
      'OTHER_LDFLAGS' => '$(inherited) -lc++ -lresolv',
      'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
      'GCC_PREPROCESSOR_DEFINITIONS' => '$(inherited) FERRUM_RELEASE=1',
      'HEADER_SEARCH_PATHS' => '"$(PODS_ROOT)/../.." "$(PODS_ROOT)/../../ferrum"',
    }

    rust_lib = File.expand_path('.nativ/generated/release/libferrum_user.a', __dir__)
    force_loads = '-force_load "$(PODS_CONFIGURATION_BUILD_DIR)/ReactNativeNativeUserCode/libReactNativeNativeUserCode.a"'
    force_loads += " -force_load \"#{rust_lib}\"" if File.exist?(rust_lib)
    s.user_target_xcconfig = {
      'OTHER_LDFLAGS' => "$(inherited) #{force_loads}",
    }
  else
    s.source_files = []
  end
end
