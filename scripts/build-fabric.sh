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

# --- Third-party dependencies ---

# folly (RN ships a subset in ReactCommon/react/third-party-ndk/folly)
# glog
# fmt
# double-conversion
# These are built by RN's own CMake infrastructure.

# Point to RN's third-party builds
set(REACT_COMMON_DIR "${REACT_COMMON_DIR}")

# RN's CMake utilities
include(${REACT_COMMON_DIR}/cmake-utils/react-native-flags.cmake)

# --- JSI (from Hermes, core only — no folly dependency) ---
add_library(jsi STATIC
    ${HERMES_ROOT}/API/jsi/jsi/jsi.cpp
)
target_include_directories(jsi PUBLIC
    ${HERMES_ROOT}/API/jsi
    ${REACT_COMMON_DIR}
)

# --- HermesABIRuntimeWrapper ---
# Built as part of the Hermes build (needs Hermes internal headers).
# Pre-built library at: vendor-lib/hermes/{platform}/libhermesABIRuntimeWrapper.a

# --- Yoga ---
file(GLOB_RECURSE YOGA_SRC
    "${REACT_COMMON_DIR}/yoga/yoga/*.cpp"
)
list(FILTER YOGA_SRC EXCLUDE REGEX "test")
list(FILTER YOGA_SRC EXCLUDE REGEX "benchmark")
add_library(yoga STATIC ${YOGA_SRC})
target_include_directories(yoga PUBLIC
    "${REACT_COMMON_DIR}/yoga"
)

# For now, create a summary target that confirms the build chain works.
# Phase 1 will add the full renderer targets.
add_custom_target(ferrum_fabric_check ALL
    DEPENDS jsi yoga
    COMMENT "Ferrum Fabric dependencies built successfully (HermesABIRuntimeWrapper built separately via Hermes CMake)"
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
