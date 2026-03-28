#!/usr/bin/env bash
# build-hermes.sh — Build Hermes V1 with C ABI from source for Ferrum.
#
# Produces static libraries with get_hermes_abi_vtable() exported.
# The prebuilt binaries from Maven/CocoaPods only export the C++ JSI API,
# which is NOT what Ferrum uses.
#
# Prerequisites:
#   - CMake 3.20+
#   - Ninja (brew install ninja)
#   - Xcode command-line tools (for iOS cross-compilation)
#   - Android NDK (for Android cross-compilation, set ANDROID_NDK_HOME)
#
# Usage:
#   ./scripts/build-hermes.sh [ios|android|all]
#
# Output:
#   vendor/hermes/
#     ├── include/           # C ABI headers
#     ├── lib/ios-arm64/     # libhermesabi.a + libhermesvm_a.a
#     └── lib/android-arm64/ # libhermesabi.a + libhermesvm_a.a

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
VENDOR_DIR="$REPO_ROOT/vendor/hermes"
HERMES_SRC="$VENDOR_DIR"

# Hermes V1 tag pinned to RN 0.84
HERMES_TAG="hermes-v250829098.0.8"

NCPU=$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)
TARGET="${1:-all}"

# ---------------------------------------------------------------------------
# Step 0: Ensure Hermes submodule is initialized
# ---------------------------------------------------------------------------
clone_hermes() {
    if [[ -f "$HERMES_SRC/CMakeLists.txt" ]]; then
        echo "==> Hermes submodule present at $HERMES_SRC"
    else
        echo "==> Initializing Hermes submodule..."
        cd "$REPO_ROOT"
        git submodule update --init --depth 1 vendor/hermes
    fi
    # Verify we're on the expected tag
    cd "$HERMES_SRC"
    local current
    current=$(git describe --tags --exact-match 2>/dev/null || echo "none")
    echo "    Hermes version: $current (expected: $HERMES_TAG)"
}

# ---------------------------------------------------------------------------
# Step 1: Build host hermesc (required for cross-compilation)
# ---------------------------------------------------------------------------
build_host_hermesc() {
    local build_dir="$HERMES_SRC/build_host"
    if [[ -f "$build_dir/bin/hermesc" ]]; then
        echo "==> Host hermesc already built"
        return
    fi

    echo "==> Building host hermesc..."
    cmake -S "$HERMES_SRC" -B "$build_dir" \
        -G Ninja \
        -DJSI_DIR="$HERMES_SRC/API/jsi" \
        -DCMAKE_BUILD_TYPE=Release \
        -DHERMES_ENABLE_DEBUGGER=OFF \
        -DHERMES_ENABLE_INTL=OFF \
        -DHERMES_ENABLE_TEST_SUITE=OFF

    cmake --build "$build_dir" --target hermesc -j "$NCPU"
    echo "    Built: $build_dir/bin/hermesc"
}

# ---------------------------------------------------------------------------
# Step 2: Build for iOS arm64 (static libraries)
# ---------------------------------------------------------------------------
build_ios() {
    local build_dir="$HERMES_SRC/build_ios_arm64"
    local out_dir="$REPO_ROOT/vendor-lib/hermes/ios-arm64"

    echo "==> Building Hermes for iOS arm64..."
    cmake -S "$HERMES_SRC" -B "$build_dir" \
        -G Ninja \
        -DCMAKE_SYSTEM_NAME=iOS \
        -DCMAKE_OSX_ARCHITECTURES=arm64 \
        -DCMAKE_OSX_DEPLOYMENT_TARGET=16.0 \
        -DIMPORT_HOST_COMPILERS="$HERMES_SRC/build_host/ImportHostCompilers.cmake" \
        -DJSI_DIR="$HERMES_SRC/API/jsi" \
        -DCMAKE_BUILD_TYPE=Release \
        -DHERMES_ENABLE_DEBUGGER=OFF \
        -DHERMES_ENABLE_INTL=OFF \
        -DHERMES_ENABLE_TEST_SUITE=OFF \
        -DHERMES_ENABLE_TOOLS=OFF

    cmake --build "$build_dir" --target hermesabi hermesvm_a -j "$NCPU"

    # Collect output
    mkdir -p "$out_dir"
    cp "$build_dir/API/hermes_abi/libhermesabi.a" "$out_dir/"
    find "$build_dir/lib" -name '*.a' -exec cp {} "$out_dir/" \;
    # Boost.Context (fibers used by Hermes StackExecutor)
    cp "$build_dir/external/boost/boost_1_86_0/libs/context/libboost_context.a" "$out_dir/"

    echo "    Output: $out_dir/"
    ls -lh "$out_dir/"
}

# ---------------------------------------------------------------------------
# Step 3: Build for Android arm64 (static libraries)
# ---------------------------------------------------------------------------
build_android() {
    if [[ -z "${ANDROID_NDK_HOME:-}" ]]; then
        echo "ERROR: ANDROID_NDK_HOME not set. Set it to your NDK path." >&2
        echo "  e.g., export ANDROID_NDK_HOME=~/Library/Android/sdk/ndk/27.0.12077973" >&2
        exit 1
    fi

    local build_dir="$HERMES_SRC/build_android_arm64"
    local out_dir="$REPO_ROOT/vendor-lib/hermes/android-arm64"

    echo "==> Building Hermes for Android arm64..."
    # Clean previous failed config
    rm -rf "$build_dir"
    cmake -S "$HERMES_SRC" -B "$build_dir" \
        -G Ninja \
        -DCMAKE_TOOLCHAIN_FILE="$ANDROID_NDK_HOME/build/cmake/android.toolchain.cmake" \
        -DANDROID_ABI=arm64-v8a \
        -DANDROID_PLATFORM=android-26 \
        -DIMPORT_HOST_COMPILERS="$HERMES_SRC/build_host/ImportHostCompilers.cmake" \
        -DJSI_DIR="$HERMES_SRC/API/jsi" \
        -DCMAKE_BUILD_TYPE=Release \
        -DHERMES_UNICODE_LITE=ON \
        -DHERMES_ENABLE_DEBUGGER=OFF \
        -DHERMES_ENABLE_INTL=OFF \
        -DHERMES_ENABLE_TEST_SUITE=OFF \
        -DHERMES_ENABLE_TOOLS=OFF

    cmake --build "$build_dir" --target hermesabi hermesvm_a -j "$NCPU"

    # Collect output
    mkdir -p "$out_dir"
    cp "$build_dir/API/hermes_abi/libhermesabi.a" "$out_dir/"
    find "$build_dir/lib" -name '*.a' -exec cp {} "$out_dir/" \;
    cp "$build_dir/external/boost/boost_1_86_0/libs/context/libboost_context.a" "$out_dir/"

    echo "    Output: $out_dir/"
    ls -lh "$out_dir/"
}

# ---------------------------------------------------------------------------
# Step 4: Copy headers
# ---------------------------------------------------------------------------
copy_headers() {
    # Headers live in the submodule at vendor/hermes/API/hermes_abi/
    # No copy needed — reference them directly from the submodule.
    echo "==> Headers available at $HERMES_SRC/API/hermes_abi/"
    ls "$HERMES_SRC/API/hermes_abi/"*.h 2>/dev/null || echo "    WARNING: headers not found"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
echo "============================================"
echo "  Hermes V1 C ABI Build for Project Ferrum"
echo "  Tag: $HERMES_TAG (RN 0.84)"
echo "  Target: $TARGET"
echo "============================================"
echo ""

clone_hermes
build_host_hermesc
copy_headers

case "$TARGET" in
    ios)     build_ios ;;
    android) build_android ;;
    all)     build_ios; build_android ;;
    *)       echo "Unknown target: $TARGET. Use ios, android, or all." >&2; exit 1 ;;
esac

echo ""
LIB_ROOT="$REPO_ROOT/vendor-lib/hermes"
echo "============================================"
echo "  Done! Libraries are in: $LIB_ROOT/"
echo ""
echo "  To build ferrum crates:"
echo "    export HERMES_LIB_DIR=$LIB_ROOT/ios-arm64"
echo "    export HERMES_ANDROID_LIB_DIR=$LIB_ROOT/android-arm64"
echo "    cargo build --target aarch64-apple-ios -p ferrum-ios"
echo "============================================"
