#!/usr/bin/env bash
# launch.sh — Build and deploy ferrum-ios to a physical iOS device.
#
# Prerequisites:
#   - Rust toolchain with aarch64-apple-ios target:
#       rustup target add aarch64-apple-ios
#   - Xcode command-line tools (codesigning, lipo):
#       xcode-select --install
#   - ios-deploy (device deployment over USB):
#       brew install ios-deploy
#   - A valid Apple Developer signing identity in your keychain.
#   - HERMES_LIB_DIR set to the directory containing libhermes.a (optional for
#     stub build, required for full Hermes evaluation):
#       export HERMES_LIB_DIR=/path/to/hermes/lib
#
# Usage:
#   ./launch.sh [--release] [--device-id <UDID>]
#
# The script:
#   1. Builds libferrum_ios.a for aarch64-apple-ios.
#   2. Creates a minimal .app bundle directory.
#   3. Copies Info.plist and bundle.js into the .app.
#   4. Links the static library into the final Ferrum binary.
#   5. Code-signs the .app.
#   6. Deploys to the connected device via ios-deploy.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CRATE_DIR="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(dirname "$(dirname "$CRATE_DIR")")"
JS_BUNDLE="$REPO_ROOT/js/test_bundle.js"

PROFILE="debug"
CARGO_FLAGS=()
DEVICE_ID=""

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
    case "$1" in
        --release)
            PROFILE="release"
            CARGO_FLAGS+=("--release")
            shift
            ;;
        --device-id)
            DEVICE_ID="$2"
            shift 2
            ;;
        *)
            echo "Unknown argument: $1" >&2
            exit 1
            ;;
    esac
done

# ---------------------------------------------------------------------------
# Step 1: Build the Rust static library
# ---------------------------------------------------------------------------
echo "==> Building ferrum-ios for aarch64-apple-ios ($PROFILE)..."
cd "$CRATE_DIR"
cargo build --target aarch64-apple-ios "${CARGO_FLAGS[@]}"

LIB_PATH="$CRATE_DIR/../../target/aarch64-apple-ios/$PROFILE/libferrum_ios.a"
if [[ ! -f "$LIB_PATH" ]]; then
    echo "ERROR: libferrum_ios.a not found at $LIB_PATH" >&2
    exit 1
fi
echo "    Built: $LIB_PATH"

# ---------------------------------------------------------------------------
# Step 2: Create the .app bundle
# ---------------------------------------------------------------------------
APP_DIR="/tmp/Ferrum.app"
echo "==> Creating .app bundle at $APP_DIR..."
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR"

# Copy Info.plist
cp "$SCRIPT_DIR/Info.plist" "$APP_DIR/Info.plist"

# Copy JS test bundle
if [[ -f "$JS_BUNDLE" ]]; then
    cp "$JS_BUNDLE" "$APP_DIR/bundle.js"
    echo "    Bundled: $JS_BUNDLE"
else
    echo "WARNING: $JS_BUNDLE not found — creating placeholder bundle.js" >&2
    cat > "$APP_DIR/bundle.js" << 'JSEOF'
// Placeholder JS bundle for Phase 0 bootstrap testing.
// EXPECT: rust_add(1, 2) = 3
const result = rust_add(1, 2);
console.log('rust_add(1, 2) =', result);
JSEOF
fi

# ---------------------------------------------------------------------------
# Step 3: Link the static library into the final binary
# ---------------------------------------------------------------------------
echo "==> Linking Ferrum binary..."

FRAMEWORKS=(
    "-framework UIKit"
    "-framework Foundation"
    "-framework QuartzCore"
)

HERMES_LINK_FLAGS=()
if [[ -n "${HERMES_LIB_DIR:-}" ]]; then
    HERMES_LINK_FLAGS=("-L$HERMES_LIB_DIR" "-lhermesabi" "-lhermesvm_a")
    echo "    Linking Hermes from $HERMES_LIB_DIR"
fi

xcrun -sdk iphoneos clang \
    -arch arm64 \
    -miphoneos-version-min=16.0 \
    -target arm64-apple-ios16.0 \
    -o "$APP_DIR/Ferrum" \
    "$LIB_PATH" \
    "${HERMES_LINK_FLAGS[@]}" \
    ${FRAMEWORKS[@]} \
    -lc++ \
    -ObjC

echo "    Linked: $APP_DIR/Ferrum"

# ---------------------------------------------------------------------------
# Step 4: Code sign
# ---------------------------------------------------------------------------
# Requires a valid "iPhone Developer" or "Apple Development" identity.
# Set CODESIGN_IDENTITY to override (e.g., "Apple Development: Your Name (TEAM_ID)").
CODESIGN_IDENTITY="${CODESIGN_IDENTITY:-iPhone Developer}"

echo "==> Code signing with identity: $CODESIGN_IDENTITY"
codesign \
    --force \
    --sign "$CODESIGN_IDENTITY" \
    --entitlements "$SCRIPT_DIR/entitlements.plist" \
    "$APP_DIR"

# ---------------------------------------------------------------------------
# Step 5: Deploy via ios-deploy
# ---------------------------------------------------------------------------
if ! command -v ios-deploy &>/dev/null; then
    echo ""
    echo "ios-deploy not found. Install it with: brew install ios-deploy"
    echo ""
    echo "Manual deployment alternative:"
    echo "  1. Open Xcode"
    echo "  2. Drag $APP_DIR onto the Devices and Simulators window"
    echo "  3. Or use: xcrun devicectl device install app --device <UDID> $APP_DIR"
    exit 0
fi

DEPLOY_FLAGS=(--bundle "$APP_DIR" --debug)
if [[ -n "$DEVICE_ID" ]]; then
    DEPLOY_FLAGS+=(--id "$DEVICE_ID")
fi

echo "==> Deploying to device..."
ios-deploy "${DEPLOY_FLAGS[@]}"
