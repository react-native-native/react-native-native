Pod::Spec.new do |s|
  s.name           = 'NativFabric'
  s.version        = '0.1.0'
  s.summary        = 'React Native Native — native component rendering + JSI runtime'
  s.author         = 'Kim Brandwijk'
  s.homepage       = 'https://react-native-native.github.io'
  s.license        = { :type => 'MIT' }
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'React-Core'
  s.dependency 'React-RCTFabric'
  s.dependency 'React-Fabric'
  s.dependency 'React-jsi'
  s.dependency 'React-utils'
  s.dependency 'React-graphics'
  s.dependency 'React-rendererdebug'
  s.dependency 'ReactCommon/turbomodule/core'
  s.dependency 'ReactCodegen'
  s.dependency 'Yoga'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'OTHER_LDFLAGS' => '$(inherited) -lc++',
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++20',
    'HEADER_SEARCH_PATHS' => '"$(PODS_ROOT)/Headers/Public/React-Fabric" ' \
                             '"$(PODS_ROOT)/Headers/Public/React-graphics" ' \
                             '"$(PODS_ROOT)/Headers/Public/ReactCodegen" ' \
                             '"$(PODS_ROOT)/Headers/Private/React-Core" ' \
                             '"$(PODS_ROOT)/Headers/Private/Yoga" ' \
                             '"${PODS_TARGET_SRCROOT}/ios/generated"',
  }

  s.source_files = [
    "ios/NativContainerComponentView.mm",
    "ios/NativRuntime.h",
    "ios/NativRuntime.mm",
    "ios/generated/**/*.{h,cpp}",
  ]
end
