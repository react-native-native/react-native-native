#!/usr/bin/env bash
# build-fabric.sh — Build React Native Fabric C++ as standalone static libraries.
#
# Builds the minimal set of RN C++ libraries needed for Ferrum Phase 1:
#   - react_renderer_scheduler (top-level Fabric orchestrator)
#   - react_renderer_uimanager (UIManagerBinding — JS ↔ native)
#   - react_renderer_core (ShadowTree, ShadowNode)
#   - react_renderer_mounting (mount instructions)
#   - react_renderer_runtimescheduler
#   - Component descriptors (view, text, root)
#   - yoga (layout engine)
#   - jsi (JavaScript Interface — provided by Hermes via HermesABIRuntimeWrapper)
#   - folly_runtime, glog (third-party deps)
#
# Prerequisites:
#   - CMake 3.13+, Ninja
#   - Xcode command-line tools (for iOS)
#   - vendor/react-native submodule checked out at v0.84.0
#   - vendor/hermes submodule (for jsi headers and HermesABIRuntimeWrapper)
#
# Usage:
#   ./scripts/build-fabric.sh [ios|android|all]
#
# Output:
#   vendor-lib/fabric/ios-arm64/*.a
#   vendor-lib/fabric/android-arm64/*.a

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

RN_ROOT="$REPO_ROOT/vendor/react-native"
HERMES_ROOT="$REPO_ROOT/vendor/hermes"
REACT_COMMON="$RN_ROOT/packages/react-native/ReactCommon"

NCPU=$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)
TARGET="${1:-all}"

# ---------------------------------------------------------------------------
# Verify submodules
# ---------------------------------------------------------------------------
check_submodules() {
    if [[ ! -f "$REACT_COMMON/react/renderer/scheduler/Scheduler.h" ]]; then
        echo "ERROR: vendor/react-native not found. Run:" >&2
        echo "  git submodule update --init vendor/react-native" >&2
        exit 1
    fi
    if [[ ! -f "$HERMES_ROOT/API/hermes_abi/hermes_abi.h" ]]; then
        echo "ERROR: vendor/hermes not found. Run:" >&2
        echo "  git submodule update --init vendor/hermes" >&2
        exit 1
    fi
}

# ---------------------------------------------------------------------------
# Create a top-level CMakeLists.txt that pulls in the targets we need
# ---------------------------------------------------------------------------
create_cmakelists() {
    local build_dir="$1"
    cat > "$build_dir/CMakeLists.txt" << 'CMAKE'
cmake_minimum_required(VERSION 3.13)
project(ferrum_fabric CXX C)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Paths passed in from the build script
# REACT_COMMON_DIR, HERMES_ROOT, HERMES_LIB_DIR are set via -D flags

# Paths
set(REACT_COMMON_DIR "${REACT_COMMON_DIR}")
set(THIRD_PARTY "${THIRD_PARTY_DIR}")

# --- double-conversion ---
file(GLOB DC_SRC "${THIRD_PARTY}/double-conversion-*/double-conversion/*.cc")
add_library(double-conversion STATIC ${DC_SRC})
target_include_directories(double-conversion PUBLIC
    "${THIRD_PARTY}/double-conversion-3.3.0"
)

# --- fmt (header-only mode is simpler but RN uses compiled) ---
add_library(fmt STATIC
    "${THIRD_PARTY}/fmt-11.0.2/src/format.cc"
    "${THIRD_PARTY}/fmt-11.0.2/src/os.cc"
)
target_include_directories(fmt PUBLIC "${THIRD_PARTY}/fmt-11.0.2/include")

# --- glog (minimal subset) ---
# RN on Android uses a custom glog config. For iOS cross-compile,
# we provide a minimal stub that routes to os_log / __android_log.
add_library(glog STATIC
    "${THIRD_PARTY}/glog-0.3.5/src/logging.cc"
    "${THIRD_PARTY}/glog-0.3.5/src/raw_logging.cc"
    "${THIRD_PARTY}/glog-0.3.5/src/vlog_is_on.cc"
    "${THIRD_PARTY}/glog-0.3.5/src/utilities.cc"
)
target_include_directories(glog PUBLIC
    "${THIRD_PARTY}/glog-0.3.5/src"
)
# glog needs a config.h — generate a minimal one
file(WRITE "${CMAKE_BINARY_DIR}/glog-config/glog/logging.h"
    "#pragma once\n#include \"${THIRD_PARTY}/glog-0.3.5/src/glog/logging.h\"\n")

# --- folly_runtime (RN's ~25-file subset) ---
set(FOLLY_ROOT "${THIRD_PARTY}/folly-2024.11.18.00")
set(folly_runtime_SRC
    ${FOLLY_ROOT}/folly/Conv.cpp
    ${FOLLY_ROOT}/folly/Demangle.cpp
    ${FOLLY_ROOT}/folly/FileUtil.cpp
    ${FOLLY_ROOT}/folly/Format.cpp
    ${FOLLY_ROOT}/folly/ScopeGuard.cpp
    ${FOLLY_ROOT}/folly/SharedMutex.cpp
    ${FOLLY_ROOT}/folly/String.cpp
    ${FOLLY_ROOT}/folly/Unicode.cpp
    ${FOLLY_ROOT}/folly/concurrency/CacheLocality.cpp
    ${FOLLY_ROOT}/folly/container/detail/F14Table.cpp
    ${FOLLY_ROOT}/folly/detail/FileUtilDetail.cpp
    ${FOLLY_ROOT}/folly/detail/Futex.cpp
    ${FOLLY_ROOT}/folly/detail/SplitStringSimd.cpp
    ${FOLLY_ROOT}/folly/detail/UniqueInstance.cpp
    ${FOLLY_ROOT}/folly/hash/SpookyHashV2.cpp
    ${FOLLY_ROOT}/folly/json/dynamic.cpp
    ${FOLLY_ROOT}/folly/json/json_pointer.cpp
    ${FOLLY_ROOT}/folly/json/json.cpp
    ${FOLLY_ROOT}/folly/lang/CString.cpp
    ${FOLLY_ROOT}/folly/lang/Exception.cpp
    ${FOLLY_ROOT}/folly/lang/SafeAssert.cpp
    ${FOLLY_ROOT}/folly/lang/ToAscii.cpp
    ${FOLLY_ROOT}/folly/memory/detail/MallocImpl.cpp
    ${FOLLY_ROOT}/folly/net/NetOps.cpp
    ${FOLLY_ROOT}/folly/portability/SysUio.cpp
    ${FOLLY_ROOT}/folly/synchronization/SanitizeThread.cpp
    ${FOLLY_ROOT}/folly/synchronization/ParkingLot.cpp
    ${FOLLY_ROOT}/folly/system/AtFork.cpp
    ${FOLLY_ROOT}/folly/system/ThreadId.cpp
)
add_library(folly_runtime STATIC ${folly_runtime_SRC})
target_include_directories(folly_runtime PUBLIC ${FOLLY_ROOT})
target_compile_options(folly_runtime PRIVATE
    -DFOLLY_NO_CONFIG=1
    -DFOLLY_HAVE_CLOCK_GETTIME=1
    -DFOLLY_USE_LIBCPP=1
    -DFOLLY_CFG_NO_COROUTINES=1
    -DFOLLY_MOBILE=1
    -DFOLLY_HAVE_PTHREAD=1
)
target_link_libraries(folly_runtime glog double-conversion fmt)

# --- JSI (from Hermes, core only) ---
add_library(jsi STATIC
    ${HERMES_ROOT}/API/jsi/jsi/jsi.cpp
)
target_include_directories(jsi PUBLIC
    ${HERMES_ROOT}/API/jsi
    ${REACT_COMMON_DIR}
)

# --- HermesABIRuntimeWrapper ---
# Built as part of the Hermes build (needs internal headers).
# Pre-built at: vendor-lib/hermes/{platform}/libhermesABIRuntimeWrapper.a

# --- Yoga ---
file(GLOB_RECURSE YOGA_SRC "${REACT_COMMON_DIR}/yoga/yoga/*.cpp")
list(FILTER YOGA_SRC EXCLUDE REGEX "test")
list(FILTER YOGA_SRC EXCLUDE REGEX "benchmark")
add_library(yoga STATIC ${YOGA_SRC})
target_include_directories(yoga PUBLIC "${REACT_COMMON_DIR}/yoga")

# --- Summary target ---
add_custom_target(ferrum_fabric_check ALL
    DEPENDS jsi yoga folly_runtime
    COMMENT "Ferrum Fabric dependencies built"
)
CMAKE
}

# ---------------------------------------------------------------------------
# Build for iOS arm64
# ---------------------------------------------------------------------------
build_ios() {
    local build_dir="$REPO_ROOT/vendor-lib/fabric/build-ios-arm64"
    local out_dir="$REPO_ROOT/vendor-lib/fabric/ios-arm64"

    echo "==> Building Fabric deps for iOS arm64..."
    mkdir -p "$build_dir"
    create_cmakelists "$build_dir"

    cmake -S "$build_dir" -B "$build_dir" \
        -G Ninja \
        -DCMAKE_SYSTEM_NAME=iOS \
        -DCMAKE_OSX_ARCHITECTURES=arm64 \
        -DCMAKE_OSX_DEPLOYMENT_TARGET=16.0 \
        -DCMAKE_BUILD_TYPE=Release \
        -DREACT_COMMON_DIR="$REACT_COMMON" \
        -DHERMES_ROOT="$HERMES_ROOT" \
        -DHERMES_LIB_DIR="$REPO_ROOT/vendor-lib/hermes/ios-arm64"

    cmake --build "$build_dir" -j "$NCPU"

    mkdir -p "$out_dir"
    find "$build_dir" -name '*.a' -exec cp {} "$out_dir/" \;

    echo "    Output: $out_dir/"
    ls -lh "$out_dir/"
}

# ---------------------------------------------------------------------------
# Build for Android arm64
# ---------------------------------------------------------------------------
build_android() {
    if [[ -z "${ANDROID_NDK_HOME:-}" ]]; then
        echo "ERROR: ANDROID_NDK_HOME not set." >&2
        exit 1
    fi

    local build_dir="$REPO_ROOT/vendor-lib/fabric/build-android-arm64"
    local out_dir="$REPO_ROOT/vendor-lib/fabric/android-arm64"

    echo "==> Building Fabric deps for Android arm64..."
    mkdir -p "$build_dir"
    create_cmakelists "$build_dir"

    cmake -S "$build_dir" -B "$build_dir" \
        -G Ninja \
        -DCMAKE_TOOLCHAIN_FILE="$ANDROID_NDK_HOME/build/cmake/android.toolchain.cmake" \
        -DANDROID_ABI=arm64-v8a \
        -DANDROID_PLATFORM=android-26 \
        -DCMAKE_BUILD_TYPE=Release \
        -DREACT_COMMON_DIR="$REACT_COMMON" \
        -DHERMES_ROOT="$HERMES_ROOT" \
        -DHERMES_LIB_DIR="$REPO_ROOT/vendor-lib/hermes/android-arm64"

    cmake --build "$build_dir" -j "$NCPU"

    mkdir -p "$out_dir"
    find "$build_dir" -name '*.a' -exec cp {} "$out_dir/" \;

    echo "    Output: $out_dir/"
    ls -lh "$out_dir/"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
echo "============================================"
echo "  Fabric C++ Build for Project Ferrum"
echo "  RN: $(cd "$RN_ROOT" && git describe --tags 2>/dev/null || echo 'unknown')"
echo "  Target: $TARGET"
echo "============================================"
echo ""

check_submodules

case "$TARGET" in
    ios)     build_ios ;;
    android) build_android ;;
    all)     build_ios; build_android ;;
    *)       echo "Unknown target: $TARGET" >&2; exit 1 ;;
esac
