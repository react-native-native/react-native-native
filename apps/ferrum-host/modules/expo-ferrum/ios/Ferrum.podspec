Pod::Spec.new do |s|
  s.name           = 'Ferrum'
  s.version        = '0.1.0'
  s.summary        = 'C ABI TurboModule acceleration for React Native'
  s.description    = 'Bypasses JSI dispatch overhead with typed objc_msgSend via Hermes C ABI. Drop-in, zero code changes.'
  s.author         = 'Kim Brandwijk'
  s.homepage       = 'https://github.com/kbrandwijk/ferrum'
  s.license        = { :type => 'MIT' }
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'hermes-engine'
  s.dependency 'React-Core'
  s.dependency 'React-jsi'
  s.dependency 'React-NativeModulesApple'
  s.dependency 'ReactCommon/turbomodule/core'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'OTHER_LDFLAGS' => '$(inherited) -lc++ -framework hermesvm -ObjC',
    'HEADER_SEARCH_PATHS' => '$(inherited) "$(PODS_ROOT)/Headers/Public/React-jsi" "$(PODS_ROOT)/Headers/Public/React-RuntimeCore" "$(PODS_ROOT)/Headers/Public/ReactCommon" "$(PODS_ROOT)/Headers/Public/hermes-engine" "$(PODS_ROOT)/hermes-engine/API/hermes_abi" "$(PODS_ROOT)/hermes-engine/API"',
    'GCC_PREPROCESSOR_DEFINITIONS' => '$(inherited) HERMES_ENABLE_DEBUGGER=0',
  }

  s.source_files = "**/*.{h,mm,cpp}"
  s.exclude_files = ["**/ExpoFerrumModule.swift"]
  s.private_header_files = ["FerrumABI*.h", "FerrumRuntimeFactory.h", "FerrumFFIDispatch.h"]
end
