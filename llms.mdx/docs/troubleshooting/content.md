# Troubleshooting (/docs/troubleshooting)



Doctor [#doctor]

The `doctor` command scans your development environment and reports any missing prerequisites:

```bash
npx nativ doctor
```

It checks:

* **Environment** — Node.js, react-native, nativ-fabric package
* **C++ / ObjC++** — Xcode clang (iOS), NDK clang (Android)
* **Swift** — swiftc (iOS only)
* **Rust** — rustc, Cargo.toml, cross-compilation targets, NDK linker
* **Kotlin** — compiler, stdlib, android.jar, d8
* **Jetpack Compose** — pretransform, wrappers, host JARs, non-embeddable compiler
* **iOS** — Xcode, Team ID, signing identity
* **Production** — podspec and Podfile configuration

Use `--platform` to check a single platform:

```bash
npx nativ doctor --platform ios
npx nativ doctor --platform android
```

Common issues [#common-issues]

Code signing identity not found [#code-signing-identity-not-found]

```
✗ No signing identity for team ABC123
```

iOS hot-reload requires code signing for `.dylib` files loaded via `dlopen`. Open **Xcode → Settings → Accounts**, select your Apple ID, and click **Download Manual Profiles** for your team.

Also ensure `appleTeamId` is set in your `app.json`:

```json
{
  "expo": {
    "ios": {
      "appleTeamId": "YOUR_TEAM_ID"
    }
  }
}
```

Rust targets missing [#rust-targets-missing]

```
✗ aarch64-apple-ios (iOS device)
✗ aarch64-linux-android (Android arm64)
```

Run the setup command to install all required targets:

```bash
npx nativ setup rust
```

Or install individually: `rustup target add aarch64-apple-ios`

Kotlin version not configured [#kotlin-version-not-configured]

```
✗ Kotlin version not configured
```

Run setup to detect and configure the Kotlin version:

```bash
npx nativ setup kotlin
```

This detects the version from `expo-build-properties` or `expo-modules-core` and saves it to `.ferrum/nativ.config.json`.

Compose toolchain missing [#compose-toolchain-missing]

```
✗ compose-pretransform JAR
✗ compose-wrappers JAR
```

Run the Compose setup to build the required JARs:

```bash
npx nativ setup compose
```

This builds three JARs needed for standalone Compose compilation outside of Gradle. Requires Java 17+.

Hot-reload timeout [#hot-reload-timeout]

```
Failed to download dylib: The request timed out.
```

The first compile for a native file (especially Rust) can take longer than the default timeout. If this happens on the very first load, subsequent loads will be fast (cached). The timeout is set to 120 seconds — if cold Rust compilation exceeds this, try saving the file again to trigger a cache hit.

RNAnywhere.h not found [#rnanywhereh-not-found]

```
fatal error: 'RNAnywhere.h' file not found
```

Clear Metro's cache and restart:

```bash
npx expo start --clear
```

This regenerates the include paths. If the issue persists, verify `@react-native-native/nativ-fabric` is installed.

dlopen crash on iOS simulator [#dlopen-crash-on-ios-simulator]

If a `.dylib` that was compiled for a physical device is loaded on a simulator (or vice versa), it will fail. React Native Native auto-detects the target — if you switch between device and simulator mid-session, the first load may 404 while the correct binary is compiled. The next save will work normally.

Expo Go not supported [#expo-go-not-supported]

React Native Native requires a **Development Build** — Expo Go cannot load custom native code. Build with:

```bash
npx expo run:ios --device
npx expo run:android --device
```
