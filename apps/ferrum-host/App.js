import { StatusBar } from "expo-status-bar";
import { useState } from "react";
import {
  StyleSheet,
  Text,
  View,
  Vibration,
  Pressable,
  ScrollView,
  Platform,
  TurboModuleRegistry,
} from "react-native";

// No extensions needed — Metro resolves per platform automatically
import HelloRust from "./HelloRust";
import { add, fast_inv_sqrt, greet } from "./math_utils";
import {
  getColorScheme,
  getScreenBrightness,
  getDeviceModel,
  getStatusBarHeight,
} from "./device_info";
import { tapLight, tapMedium, tapHeavy, notifySuccess } from "./haptics";
import { fibonacci, is_prime, greet_rust } from "./rust_math";
import { deviceName, systemVersion, batteryLevel } from "./platform_info";
import GradientBox from "./GradientBox";
import GpuTriangle from "./GpuTriangle";
import SwiftCounter from "./SwiftCounter";
import KotlinCounter from "./KotlinCounter";
import ComposeCard from "./ComposeCard";
import { factorial, isPalindrome, greetKotlin } from "./kotlin_utils";
import { slowGreet, heavyCompute, fetchURL } from "./async_demo";

// const TurboModuleRegistry = require("react-native/Libraries/TurboModule/TurboModuleRegistry");
const SYNC_ROUNDS = 10000;
const ASYNC_ROUNDS = 200;

function bench(fn, isAsync) {
  const rounds = isAsync ? ASYNC_ROUNDS : SYNC_ROUNDS;
  for (let i = 0; i < 50; i++) fn(); // warmup
  const t = performance.now();
  for (let i = 0; i < rounds; i++) fn();
  return (((performance.now() - t) * 1000) / rounds).toFixed(2);
}

function compare(moduleName, methodName, isAsync, ...methodArgs) {
  const jsi = global.__ferrumGetJSIModule?.(moduleName);
  const proxy = TurboModuleRegistry.getEnforcing(moduleName);
  const direct = global.__ferrumGetModule?.(moduleName);
  if (!proxy?.[methodName]) return "method not found";
  const rounds = isAsync ? ASYNC_ROUNDS : SYNC_ROUNDS;
  const jsiUs = jsi?.[methodName]
    ? bench(() => jsi[methodName](...methodArgs), isAsync)
    : "?";
  const proxyUs = bench(() => proxy[methodName](...methodArgs), isAsync);
  const directUs = direct?.[methodName]
    ? bench(() => direct[methodName](...methodArgs), isAsync)
    : "N/A";
  return `JSI: ${jsiUs} · Proxy: ${proxyUs} · FFI: ${directUs} (${rounds}×)`;
}

const noop = () => {};

function AsyncButton({ label, onPress }) {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  return (
    <Pressable
      style={[styles.resultBox, { marginVertical: 4 }]}
      onPress={async () => {
        setLoading(true);
        setResult(null);
        try {
          const t = performance.now();
          const res = await onPress();
          const ms = (performance.now() - t).toFixed(0);
          setResult(`${String(res).slice(0, 80)} (${ms}ms)`);
        } catch (e) {
          setResult(`Error: ${e.message}`);
        }
        setLoading(false);
      }}
    >
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.result}>
        {loading ? 'loading...' : result || 'tap to test'}
      </Text>
    </Pressable>
  );
}

export default function App() {
  const [results, setResults] = useState({});
  const run = (key, fn) => setResults((r) => ({ ...r, [key]: fn() }));

  const cards = [
    {
      label: "import { Vibration } → vibrate(1)",
      sub: "Real-world: RN wrapper → Ferrum proxy → typed objc_msgSend",
      key: "realworld",
      fn: () => {
        Vibration.vibrate(1); // warmup / trigger lazy load
        const rnUs = bench(() => Vibration.vibrate(1), true);
        const proxy = TurboModuleRegistry.getEnforcing("Vibration");
        const proxyUs = bench(() => proxy.vibrate(1), true);
        return `RN import: ${rnUs} · Direct proxy: ${proxyUs} (${ASYNC_ROUNDS}×)`;
      },
    },
    {
      label: "Vibration.vibrate(1)",
      sub: "void(double) — fire-and-forget",
      key: "vibration",
      fn: () => compare("Vibration", "vibrate", true, 1),
    },
    {
      label: "Clipboard.setString()",
      sub: "void(id) — ObjC object arg",
      key: "clipboard",
      fn: () => compare("Clipboard", "setString", true, "ferrum"),
    },
    {
      label: "Appearance.getColorScheme()",
      sub: "id() → NSString — sync return",
      key: "appearance",
      fn: () => {
        const val =
          TurboModuleRegistry.getEnforcing("Appearance").getColorScheme?.();
        return `"${val}" — ` + compare("Appearance", "getColorScheme", false);
      },
    },
    {
      label: "StatusBar.getHeight(cb)",
      sub: "void(block) — callback arg",
      key: "statusbar",
      fn: () => compare("StatusBarManager", "getHeight", true, noop),
    },
    {
      label: "StatusBar.setStyle(str, bool)",
      sub: "void(id, BOOL) — mixed arg types",
      key: "setstyle",
      fn: () => compare("StatusBarManager", "setStyle", true, "default", false),
    },
    {
      label: "StatusBar.setHidden(bool, str)",
      sub: "void(BOOL, id) — reversed mixed types",
      key: "sethidden",
      fn: () => compare("StatusBarManager", "setHidden", true, false, "none"),
    },
    {
      label: "Networking.clearCookies(cb)",
      sub: "void(block) — callback pattern",
      key: "networking",
      fn: () => compare("Networking", "clearCookies", true, noop),
    },
    {
      label: "Appearance.setColorScheme(str)",
      sub: "void(id) — sync string arg",
      key: "setscheme",
      fn: () => compare("Appearance", "setColorScheme", true, "light"),
    },
    {
      label: "Linking.canOpenURL(url, ✓, ✗)",
      sub: "void(NSURL, resolve, reject) — RCTConvert",
      key: "linking",
      fn: () => {
        // JSI: Promise method — pass only the URL, codegen adds resolve/reject
        const jsi = global.__ferrumGetJSIModule?.("LinkingManager");
        const jsiUs = jsi?.canOpenURL
          ? bench(() => {
              try {
                jsi.canOpenURL("https://example.com");
              } catch (e) {}
            }, true)
          : "?";
        // Proxy/FFI: void(NSURL, block, block) — pass all 3 args directly
        const proxy = TurboModuleRegistry.getEnforcing("LinkingManager");
        const direct = global.__ferrumGetModule?.("LinkingManager");
        const proxyUs = bench(
          () => proxy.canOpenURL("https://example.com", noop, noop),
          true,
        );
        const directUs = direct?.canOpenURL
          ? bench(
              () => direct.canOpenURL("https://example.com", noop, noop),
              true,
            )
          : "N/A";
        return `JSI: ${jsiUs} · Proxy: ${proxyUs} · FFI: ${directUs} (${ASYNC_ROUNDS}×)`;
      },
    },
  ];

  return (
    <ScrollView style={styles.container}>
      <Text style={styles.title}>Project Ferrum</Text>
      <Text style={styles.subtitle}>JSI vs Proxy vs FFI — μs/call</Text>

      <View style={styles.ferrumBox}>
        <Text style={styles.ferrumLabel}>FerrumContainer (Fabric)</Text>
        <HelloRust
          style={{ width: "100%", height: 100 }}
          text="Props directly from JS!"
          r={0.1}
          g={0.9}
          b={0.9}
        />
      </View>

      {Platform.OS === "ios" && (
        <View style={styles.ferrumBox}>
          <Text style={styles.ferrumLabel}>
            ObjC++ Component (CAGradientLayer)
          </Text>
          <GradientBox
            style={{
              width: "100%",
              height: 70,
              borderRadius: 12,
              overflow: "hidden",
            }}
            title="Propz from JS!"
            cornerRadius={20}
          />
        </View>
      )}

      {/* <View style={styles.ferrumBox}>
        <Text style={styles.ferrumLabel}>Rust + wgpu (Metal GPU)</Text>
        <GpuTriangle style={{ width: "100%", height: 100 }} />
      </View> */}

      {Platform.OS === "ios" && (
        <View style={styles.ferrumBox}>
          <Text style={styles.ferrumLabel}>SwiftUI Component</Text>
          <SwiftCounter
            style={{
              width: "100%",
              height: 80,
              borderRadius: 12,
              overflow: "hidden",
            }}
            title="Hello from SwiftUI!"
            r={0.7}
            g={0.5}
            b={0.9}
          />
        </View>
      )}

      {Platform.OS === "android" && (
        <View style={styles.ferrumBox}>
          <Text style={styles.ferrumLabel}>Jetpack Compose Component</Text>
          <ComposeCard
            style={{
              width: "100%",
              height: 100,
              borderRadius: 12,
              overflow: "hidden",
            }}
            title="Hello from Compose!"
          />
        </View>
      )}

      {Platform.OS === "android" && (
        <View style={styles.ferrumBox}>
          <Text style={styles.ferrumLabel}>
            Kotlin Component (Android Views)
          </Text>
          <KotlinCounter
            style={{
              width: "100%",
              height: 80,
              borderRadius: 12,
              overflow: "hidden",
            }}
            title="Hello from Kotlin!"
            color="purple"
          />
        </View>
      )}

      {Platform.OS === "android" && (
        <View style={styles.ferrumBox}>
          <Text style={styles.ferrumLabel}>Kotlin functions via .dex</Text>
          <Text style={styles.result}>
            factorial(10) = {String(factorial?.(10) ?? "N/A")}
          </Text>
          <Text style={styles.result}>
            isPalindrome("racecar") ={" "}
            {String(isPalindrome?.("racecar") ?? "N/A")}
          </Text>
          <Text style={styles.result}>
            {greetKotlin?.("Ferrrrrum") ?? "N/A"}
          </Text>
        </View>
      )}

      <View style={styles.ferrumBox}>
        <Text style={styles.ferrumLabel}>C++ via react-native-anywhere</Text>
        <Text style={styles.result}>add(2, 3) = {String(add(2, 3))}</Text>
        <Text style={styles.result}>
          fast_inv_sqrt(4) = {String(fast_inv_sqrt(4))}
        </Text>
        <Text style={styles.result}>{greet("Ferrum")}</Text>
      </View>

      {Platform.OS === "ios" && (
        <View style={styles.ferrumBox}>
          <Text style={styles.ferrumLabel}>Swift via @_cdecl</Text>
          <Text style={styles.result}>device: {deviceName()}</Text>
          <Text style={styles.result}>os: {systemVersion()}</Text>
          <Text style={styles.result}>battery: {String(batteryLevel())}</Text>
        </View>
      )}

      <View style={styles.ferrumBox}>
        <Text style={styles.ferrumLabel}>Rust functions via #[function]</Text>
        <Text style={styles.result}>
          fibonacci(10) = {String(fibonacci(10))}
        </Text>
        <Text style={styles.result}>is_prime(97) = {String(is_prime(97))}</Text>
        <Text style={styles.result}>{greet_rust("Ferrum")}</Text>
      </View>

      {Platform.OS === "ios" && (
        <View style={styles.ferrumBox}>
          <Text style={styles.ferrumLabel}>ObjC++ — iOS platform APIs</Text>
          <Text style={styles.result}>colorScheme: {getColorScheme()}</Text>
          <Text style={styles.result}>
            brightness: {getScreenBrightness().toFixed(2)}
          </Text>
          <Text style={styles.result}>device: {getDeviceModel()}</Text>
          <Text style={styles.result}>statusBar: {getStatusBarHeight()}px</Text>
        </View>
      )}

      {Platform.OS === "ios" && (
        <View style={styles.ferrumBox}>
          <Text style={styles.ferrumLabel}>ObjC++ — Haptic Feedback</Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Pressable style={styles.resultBox} onPress={() => tapLight()}>
              <Text style={styles.result}>Light</Text>
            </Pressable>
            <Pressable style={styles.resultBox} onPress={() => tapMedium()}>
              <Text style={styles.result}>Medium</Text>
            </Pressable>
            <Pressable style={styles.resultBox} onPress={() => tapHeavy()}>
              <Text style={styles.result}>Heavy</Text>
            </Pressable>
            <Pressable style={styles.resultBox} onPress={() => notifySuccess()}>
              <Text style={styles.result}>Success</Text>
            </Pressable>
          </View>
        </View>
      )}

      {/* <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
      >
        {cards.map((card) => (
          <Pressable
            key={card.key}
            style={styles.resultBox}
            onPress={() => run(card.key, card.fn)}
          >
            <Text style={styles.label}>{card.label}</Text>
            <Text style={styles.sub}>{card.sub}</Text>
            <Text style={styles.result}>
              {results[card.key] || "tap to test"}
            </Text>
          </Pressable>
        ))}
      </ScrollView> */}

      {/* ── Async Functions ──────────────────────────── */}
      <View style={styles.ferrumBox}>
        <Text style={styles.ferrumLabel}>Async Functions (ObjC++)</Text>
        <AsyncButton
          label="slowGreet('World')"
          onPress={() => slowGreet('World')}
        />
        <AsyncButton
          label="heavyCompute(40)"
          onPress={() => heavyCompute(40)}
        />
        <AsyncButton
          label="fetchURL (httpbin)"
          onPress={() => fetchURL('https://httpbin.org/get')}
        />
      </View>

      <StatusBar style="light" />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#1a1a2e",
    paddingTop: 60,
    paddingHorizontal: 16,
  },
  title: {
    fontSize: 28,
    fontWeight: "700",
    color: "#e94560",
    textAlign: "center",
    marginBottom: 2,
  },
  subtitle: {
    fontSize: 12,
    color: "#8888aa",
    textAlign: "center",
    marginBottom: 12,
  },
  scroll: { flex: 1 },
  scrollContent: { gap: 8, paddingBottom: 40 },
  resultBox: {
    backgroundColor: "#16213e",
    borderRadius: 12,
    padding: 14,
  },
  label: {
    fontSize: 13,
    fontWeight: "600",
    color: "#e94560",
  },
  sub: {
    fontSize: 10,
    color: "#666688",
    marginBottom: 6,
  },
  result: {
    fontSize: 14,
    fontFamily: "Courier",
    color: "#4ecca3",
    textAlign: "center",
  },
  ferrumBox: {
    backgroundColor: "#16213e",
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    overflow: "hidden",
  },
  ferrumLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: "#e94560",
    marginBottom: 8,
  },
});
