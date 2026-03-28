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
  # Depend on hermes-engine so we get its headers and link against same VM
  s.dependency 'hermes-engine'

  # Only the Rust static library is vendored.
  # hermes_vtable.cpp and HermesABIRuntimeWrapper.cpp are compiled from source
  # alongside the pods' Hermes, ensuring ABI compatibility.
  s.vendored_libraries = [
    'libferrum_ios.a',
    'libhermesabi.a',
    'libhermesABIRuntimeWrapper.a',
  ]

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'OTHER_LDFLAGS' => '$(inherited) -lc++ -framework hermesvm',
    # Hermes internal headers needed by hermes_vtable.cpp
    'HEADER_SEARCH_PATHS' => '$(inherited) "$(PODS_ROOT)/../../../../vendor/hermes/API/hermes_abi" "$(PODS_ROOT)/../../../../vendor/hermes/API/jsi" "$(PODS_ROOT)/../../../../vendor/hermes/API" "$(PODS_ROOT)/../../../../vendor/hermes/public" "$(PODS_ROOT)/../../../../vendor/hermes/include" "$(PODS_ROOT)/../../../../vendor/hermes/lib" "$(PODS_ROOT)/../../../../vendor/hermes/external/llvh/include" "$(PODS_ROOT)/../../../../vendor/hermes/build_ios_arm64/external/llvh/include" "$(PODS_ROOT)/../../../../vendor/hermes/external/flowparser/include" "$(PODS_ROOT)/../../../../vendor/hermes" "$(PODS_ROOT)/Headers/Public/React-jsi" "$(PODS_ROOT)/Headers/Public/React-RuntimeCore" "$(PODS_ROOT)/Headers/Public/React-jsitooling" "$(PODS_ROOT)/Headers/Public/React-jsinspector" "$(PODS_ROOT)/Headers/Public/React-jsinspectorcdp" "$(PODS_ROOT)/Headers/Public/hermes-engine"',
    'GCC_PREPROCESSOR_DEFINITIONS' => '$(inherited) HERMES_ENABLE_DEBUGGER=0',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
