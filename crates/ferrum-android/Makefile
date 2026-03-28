# ferrum-android/Makefile
#
# Build and deploy the Ferrum Android Phase 0 binary.
#
# Prerequisites:
#   - Rust toolchain with aarch64-linux-android target:
#       rustup target add aarch64-linux-android
#   - cargo-ndk: cargo install cargo-ndk
#   - Android NDK (set ANDROID_NDK_HOME or install via Android Studio)
#   - Android SDK with build-tools (set ANDROID_HOME or ANDROID_SDK_ROOT)
#   - A connected Android device or emulator (for install/run targets)
#
# Environment variables:
#   ANDROID_NDK_HOME   — path to NDK (e.g. ~/Library/Android/sdk/ndk/26.3.11579264)
#   ANDROID_HOME       — path to Android SDK
#   HERMES_ANDROID_LIB_DIR — path to directory containing libhermes.so (arm64-v8a)
#
# Usage:
#   make build          # Build debug .so and APK
#   make build-release  # Build release .so and APK
#   make install        # Build and install APK on connected device
#   make run            # Build, install, and launch the Activity
#   make logcat         # Stream Ferrum-tagged logcat output
#   make clean          # Remove build artifacts

CRATE_NAME := ferrum_android
ANDROID_TARGET := aarch64-linux-android
ABI := arm64-v8a

ANDROID_DIR := $(CURDIR)/android
APP_DIR := $(ANDROID_DIR)/app
JNI_LIBS_DIR := $(APP_DIR)/src/main/jniLibs/$(ABI)

# Cargo workspace root (three levels up from this Makefile)
WORKSPACE_ROOT := $(CURDIR)/../../..

# Gradle wrapper
GRADLEW := $(ANDROID_DIR)/gradlew

.PHONY: build build-release so so-release copy-so copy-so-release apk apk-release \
        install install-release run logcat clean check setup-ndk

# ---------------------------------------------------------------------------
# Primary targets
# ---------------------------------------------------------------------------

## Build debug APK (default target)
build: so copy-so apk

## Build release APK
build-release: so-release copy-so-release apk-release

## Install debug APK on connected device
install: build
	$(GRADLEW) -p $(ANDROID_DIR) installDebug

## Install release APK on connected device
install-release: build-release
	$(GRADLEW) -p $(ANDROID_DIR) installRelease

## Build, install, and launch the Activity
run: install
	adb shell am start -n com.ferrum.app/.MainActivity
	$(MAKE) logcat

## Stream logcat filtered to Ferrum tag
logcat:
	adb logcat -s ferrum:V AndroidRuntime:E -v time

# ---------------------------------------------------------------------------
# Rust build targets
# ---------------------------------------------------------------------------

## Build the Rust .so (debug)
so:
	cd $(WORKSPACE_ROOT) && \
	HERMES_ANDROID_LIB_DIR="$(HERMES_ANDROID_LIB_DIR)" \
	cargo ndk \
		--target $(ANDROID_TARGET) \
		--platform 26 \
		-o /tmp/ferrum-ndk-output \
		build \
		-p $(CRATE_NAME)
	@echo "Built: /tmp/ferrum-ndk-output/$(ABI)/lib$(CRATE_NAME).so"

## Build the Rust .so (release)
so-release:
	cd $(WORKSPACE_ROOT) && \
	HERMES_ANDROID_LIB_DIR="$(HERMES_ANDROID_LIB_DIR)" \
	cargo ndk \
		--target $(ANDROID_TARGET) \
		--platform 26 \
		-o /tmp/ferrum-ndk-output-release \
		build \
		-p $(CRATE_NAME) \
		--release
	@echo "Built: /tmp/ferrum-ndk-output-release/$(ABI)/lib$(CRATE_NAME).so"

## Copy debug .so to Android jniLibs
copy-so: so
	mkdir -p $(JNI_LIBS_DIR)
	cp /tmp/ferrum-ndk-output/$(ABI)/lib$(CRATE_NAME).so $(JNI_LIBS_DIR)/
	@echo "Copied .so to $(JNI_LIBS_DIR)/"

## Copy release .so to Android jniLibs
copy-so-release: so-release
	mkdir -p $(JNI_LIBS_DIR)
	cp /tmp/ferrum-ndk-output-release/$(ABI)/lib$(CRATE_NAME).so $(JNI_LIBS_DIR)/
	@echo "Copied .so to $(JNI_LIBS_DIR)/"

# ---------------------------------------------------------------------------
# Hermes .so: copy alongside ferrum_android.so
# ---------------------------------------------------------------------------
## Copy libhermes.so to jniLibs (required if linking dynamically)
copy-hermes:
ifndef HERMES_ANDROID_LIB_DIR
	$(error HERMES_ANDROID_LIB_DIR is not set. See build.rs for acquisition instructions.)
endif
	mkdir -p $(JNI_LIBS_DIR)
	cp $(HERMES_ANDROID_LIB_DIR)/libhermes.so $(JNI_LIBS_DIR)/
	@echo "Copied libhermes.so to $(JNI_LIBS_DIR)/"

# ---------------------------------------------------------------------------
# Gradle targets
# ---------------------------------------------------------------------------

## Assemble debug APK only (no Rust build)
apk:
	$(GRADLEW) -p $(ANDROID_DIR) assembleDebug
	@echo "APK: $(APP_DIR)/build/outputs/apk/debug/app-debug.apk"

## Assemble release APK only (no Rust build)
apk-release:
	$(GRADLEW) -p $(ANDROID_DIR) assembleRelease
	@echo "APK: $(APP_DIR)/build/outputs/apk/release/app-release.apk"

# ---------------------------------------------------------------------------
# Utility targets
# ---------------------------------------------------------------------------

## cargo check for IDE / fast feedback (no link step)
check:
	cd $(WORKSPACE_ROOT) && \
	cargo check \
		--target $(ANDROID_TARGET) \
		-p $(CRATE_NAME)

## Print NDK and SDK configuration for debugging
setup-ndk:
	@echo "ANDROID_NDK_HOME = $(ANDROID_NDK_HOME)"
	@echo "ANDROID_HOME     = $(ANDROID_HOME)"
	@echo "HERMES_ANDROID_LIB_DIR = $(HERMES_ANDROID_LIB_DIR)"
	@rustup target list --installed | grep android || echo "No Android Rust targets installed"
	@cargo ndk --version 2>/dev/null || echo "cargo-ndk not found: cargo install cargo-ndk"

## Remove all build artifacts
clean:
	cd $(WORKSPACE_ROOT) && cargo clean -p $(CRATE_NAME)
	$(GRADLEW) -p $(ANDROID_DIR) clean
	rm -rf /tmp/ferrum-ndk-output /tmp/ferrum-ndk-output-release
	rm -f $(JNI_LIBS_DIR)/lib$(CRATE_NAME).so

## Print this help
help:
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/## //'
