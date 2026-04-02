cmake_minimum_required(VERSION 3.13)
project(nativruntime)

set(CMAKE_CXX_STANDARD 20)

# Map ANDROID_ABI to prefab triple
if(ANDROID_ABI STREQUAL "arm64-v8a")
  set(_TRIPLE "aarch64-linux-android")
elseif(ANDROID_ABI STREQUAL "armeabi-v7a")
  set(_TRIPLE "arm-linux-androideabi")
elseif(ANDROID_ABI STREQUAL "x86_64")
  set(_TRIPLE "x86_64-linux-android")
elseif(ANDROID_ABI STREQUAL "x86")
  set(_TRIPLE "i686-linux-android")
endif()

# Include prefab Config files
list(GET CMAKE_FIND_ROOT_PATH 0 _PREFAB_ROOT)
set(_PREFAB "${_PREFAB_ROOT}/lib/${_TRIPLE}/cmake")
include("${_PREFAB}/fbjni/fbjniConfig.cmake")
include("${_PREFAB}/ReactAndroid/ReactAndroidConfig.cmake")

add_library(nativruntime SHARED
    FerrumRuntime.cpp
    RNABindingsInstaller.cpp
)

target_link_libraries(nativruntime
    fbjni::fbjni
    ReactAndroid::jsi
    ReactAndroid::reactnative
    android
    log
)

# Production: statically link user native code into libnativruntime.so.
if(NATIV_RELEASE)
  target_compile_definitions(nativruntime PRIVATE NATIV_RELEASE=1)

  file(GLOB_RECURSE NATIV_USER_SOURCES
    "${CMAKE_SOURCE_DIR}/../../../../../../.nativ/generated/bridges/android/*.cpp"
    "${CMAKE_SOURCE_DIR}/../../../../../../.nativ/generated/bridges/android/*.c"
  )
  if(NATIV_USER_SOURCES)
    target_sources(nativruntime PRIVATE ${NATIV_USER_SOURCES})
  endif()

  target_include_directories(nativruntime PRIVATE
    "${CMAKE_SOURCE_DIR}/../../../.."
    "${CMAKE_SOURCE_DIR}/../../../../../../ferrum"
  )

  set(NATIV_RUST_LIB "${CMAKE_SOURCE_DIR}/../../../../../../.nativ/generated/release/${ANDROID_ABI}/libnativ_user.a")
  if(EXISTS ${NATIV_RUST_LIB})
    target_link_libraries(nativruntime -Wl,--whole-archive ${NATIV_RUST_LIB} -Wl,--no-whole-archive)
  endif()
endif()
