cmake_minimum_required(VERSION 3.13)
project(ferrum)

set(CMAKE_CXX_STANDARD 20)

# Map ANDROID_ABI to the triple used in prefab paths
if(ANDROID_ABI STREQUAL "arm64-v8a")
  set(_TRIPLE "aarch64-linux-android")
elseif(ANDROID_ABI STREQUAL "armeabi-v7a")
  set(_TRIPLE "arm-linux-androideabi")
elseif(ANDROID_ABI STREQUAL "x86_64")
  set(_TRIPLE "x86_64-linux-android")
elseif(ANDROID_ABI STREQUAL "x86")
  set(_TRIPLE "i686-linux-android")
endif()

# Include prefab Config files directly — find_package rejects them
# due to a version bug in prefab's ConfigVersion files.
list(GET CMAKE_FIND_ROOT_PATH 0 _PREFAB_ROOT)
set(_PREFAB "${_PREFAB_ROOT}/lib/${_TRIPLE}/cmake")
include("${_PREFAB}/fbjni/fbjniConfig.cmake")
include("${_PREFAB}/ReactAndroid/ReactAndroidConfig.cmake")

add_library(ferrum SHARED
  FerrumBindings.cpp
  FerrumJNIDispatch.cpp
)

target_link_libraries(ferrum
  fbjni::fbjni
  ReactAndroid::jsi
  ReactAndroid::reactnative
  log
)
