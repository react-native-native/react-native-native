Pod::Spec.new do |s|
  s.name           = 'ExpoFerrum'
  s.version        = '0.1.0'
  s.summary        = 'Ferrum: Rust-hosted React Native orchestrator'
  s.description    = 'Expo module that initializes the Ferrum runtime'
  s.author         = 'Kim Brandwijk'
  s.homepage       = 'https://github.com/ferrum'
  s.platforms      = { :ios => '15.1', :tvos => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Vendored static libraries — survive expo prebuild since they live
  # in modules/expo-ferrum/ios/ (not in the generated ios/ directory).
  # Symlinks point to:
  #   - libferrum_ios.a → target/aarch64-apple-ios/debug/ (Rust)
  #   - libhermesabi.a etc. → vendor-lib/hermes/ios-arm64/ (Hermes C ABI)
  s.vendored_libraries = [
    'libferrum_ios.a',
    'libhermesabi.a',
    'libhermesvm_a.a',
    'libhermesVMRuntime.a',
    'libhermesABIRuntimeWrapper.a',
    'libboost_context.a',
  ]

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'OTHER_LDFLAGS' => '$(inherited) -lc++',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
