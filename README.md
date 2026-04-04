# React Native Native

Write native components and modules in **Rust, C++, Kotlin/Compose, Swift/ObjC** — and hot-reload them on a physical device, just like JavaScript.

> **Experimental.** Core functionality works, but certain language-specific features may be incomplete or unstable. Currently only tested on macOS.

## Why?

React Native's native module system requires you to write Swift/Kotlin wrappers, maintain Xcode/Android Studio projects, and rebuild the entire app for every change. React Native Native removes all of that:

- **Write native code in your editor** — no IDE switching
- **Save and see** — Metro compiles, signs, and hot-reloads native code on device
- **Full platform SDK access** — use any iOS framework or Android API directly
- **Works with Expo** — drops into any Expo project as a module

## Quick start

```bash
npx create-expo-app MyApp --template @react-native-native/template-starter
cd MyApp
npx expo run:ios    # or run:android
```

Edit `hello.cpp`, save, and watch it hot-reload on device.

## How it works

Your native code becomes a React component or module that JS can use like any other:

```tsx
import { fibonacci } from './rust_math';    // Rust function
import GradientBox from './GradientBox';    // ObjC++ component

<Text>{fibonacci(10)}</Text>
<GradientBox title="Hello!" style={{ width: 300, height: 200 }} />
```

**Development** — Metro compiles native files to signed dynamic libraries, serves them over HTTP, and the device hot-reloads them via `dlopen` (iOS) or `DexClassLoader` (Android).

**Production** — All native code is statically linked into the app binary. No dynamic libraries, no runtime code loading. CocoaPods (iOS) and Gradle (Android) handle compilation automatically.

## Supported languages

| Language | Functions | Components | Hot-reload | iOS | Android |
|----------|-----------|------------|------------|-----|---------|
| C++ | Yes | Yes | Yes | Yes | Yes |
| Objective-C++ | Yes | Yes | Yes | Yes | — |
| Swift | Yes | — | Yes | Yes | Yes* |
| SwiftUI | — | Yes | Yes | Yes | — |
| Rust | Yes | Yes | Yes | Yes | Yes |
| Kotlin | Yes | Yes | Yes | — | Yes |
| Kotlin + Compose | — | Yes | Yes | — | Yes |

*Swift on Android requires the [Swift SDK for Android](https://www.swift.org/documentation/articles/swift-sdk-for-android-getting-started.html) (Swift 6.3+). Function exports work cross-platform; SwiftUI components are iOS-only.

## Documentation

Full docs, guides, and API reference at **[react-native-native.github.io](https://react-native-native.github.io)**

- [Installation](https://react-native-native.github.io/docs/getting-started/installation)
- [Hello World](https://react-native-native.github.io/docs/getting-started/hello-world)
- [C++ Guide](https://react-native-native.github.io/docs/guides/cpp)
- [Rust Guide](https://react-native-native.github.io/docs/guides/rust)
- [Kotlin Guide](https://react-native-native.github.io/docs/guides/kotlin)
- [Production Builds](https://react-native-native.github.io/docs/getting-started/production)

## Packages

| Package | Description |
|---------|-------------|
| [`@react-native-native/nativ-fabric`](https://www.npmjs.com/package/@react-native-native/nativ-fabric) | Core runtime — Metro transformer, JSI bindings, native bridge |
| [`@react-native-native/cli`](https://www.npmjs.com/package/@react-native-native/cli) | CLI tools — setup, diagnostics, build commands |
| [`@react-native-native/template-starter`](https://www.npmjs.com/package/@react-native-native/template-starter) | Expo template with hello.cpp example |
| [`nativ-core`](https://crates.io/crates/nativ-core) | Rust crate — NativeView, props, FFI types |
| [`nativ-macros`](https://crates.io/crates/nativ-macros) | Rust proc macros — `#[component]`, `#[function]` |

## License

MIT
