cmake_minimum_required(VERSION 3.13)
project(ferrumruntime)

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

add_library(ferrumruntime SHARED
    FerrumRuntime.cpp
    RNABindingsInstaller.cpp
)

target_link_libraries(ferrumruntime
    fbjni::fbjni
    ReactAndroid::jsi
    ReactAndroid::reactnative
    android
    log
)

# Production: statically link user native code into libferrumruntime.so.
if(FERRUM_RELEASE)
  target_compile_definitions(ferrumruntime PRIVATE FERRUM_RELEASE=1)

  file(GLOB_RECURSE FERRUM_USER_SOURCES
    "${CMAKE_SOURCE_DIR}/../../../../../../.ferrum/generated/bridges/android/*.cpp"
    "${CMAKE_SOURCE_DIR}/../../../../../../.ferrum/generated/bridges/android/*.c"
  )
  if(FERRUM_USER_SOURCES)
    target_sources(ferrumruntime PRIVATE ${FERRUM_USER_SOURCES})
  endif()

  target_include_directories(ferrumruntime PRIVATE
    "${CMAKE_SOURCE_DIR}/../../../.."
    "${CMAKE_SOURCE_DIR}/../../../../../../ferrum"
  )

  set(FERRUM_RUST_LIB "${CMAKE_SOURCE_DIR}/../../../../../../.ferrum/generated/release/${ANDROID_ABI}/libferrum_user.a")
  if(EXISTS ${FERRUM_RUST_LIB})
    target_link_libraries(ferrumruntime -Wl,--whole-archive ${FERRUM_RUST_LIB} -Wl,--no-whole-archive)
  endif()
endif()
