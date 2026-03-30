Pod::Spec.new do |s|
  s.name           = 'Ferrum'
  s.version        = '0.2.0'
  s.summary        = 'TurboModule acceleration for React Native'
  s.description    = 'Bypasses NSInvocation with typed objc_msgSend. Drop-in, zero config, no vendored Hermes.'
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
  s.dependency 'React-callinvoker'
  s.dependency 'ReactCommon/turbomodule/core'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'OTHER_LDFLAGS' => '$(inherited) -lc++ -framework hermesvm',
    'GCC_PREPROCESSOR_DEFINITIONS' => '$(inherited) HERMES_ENABLE_DEBUGGER=0',
  }

  # Only the 3 core files
  s.source_files = [
    "Ferrum.mm",
    "FerrumFFIDispatch.h",
    "FerrumFFIDispatch.mm",
    "FerrumBench.mm",
  ]
end
