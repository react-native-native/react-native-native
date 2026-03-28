Pod::Spec.new do |s|
  s.name           = 'ExpoFerrum'
  s.version        = '0.1.0'
  s.summary        = 'Ferrum: Rust-hosted React Native orchestrator'
  s.description    = 'Expo module that initializes the Ferrum runtime — Rust process ownership with Hermes V1 C ABI'
  s.author         = 'Kim Brandwijk'
  s.homepage       = 'https://github.com/ferrum'
  s.platforms      = { :ios => '16.0' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    # Link the Ferrum Rust static library and Hermes C ABI libs.
    # These are built by scripts/build-hermes.sh and cargo build.
    # Paths are relative to the Pods project during xcodebuild.
    'OTHER_LDFLAGS' => '$(inherited) -lferrum_ios -lhermesabi -lhermesvm_a -lhermesVMRuntime -lboost_context -lhermesABIRuntimeWrapper -lc++',
    'LIBRARY_SEARCH_PATHS' => '$(inherited) "${PODS_ROOT}/../../../../../../vendor-lib/hermes/ios-arm64" "${PODS_ROOT}/../../../../../../target/aarch64-apple-ios/debug"',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
