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

  # Rust static library — contains ferrum_bridge_init / ferrum_bridge_free_string
  s.vendored_libraries = 'libferrum_ios.a'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
