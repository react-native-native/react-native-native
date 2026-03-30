import { StatusBar } from "expo-status-bar";
import { useState } from "react";
import {
  StyleSheet,
  Text,
  View,
  Vibration,
  Pressable,
  ScrollView,
} from "react-native";

const TurboModuleRegistry = require("react-native/Libraries/TurboModule/TurboModuleRegistry");
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
        const val = TurboModuleRegistry.getEnforcing("Appearance").getColorScheme?.();
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
          ? bench(() => { try { jsi.canOpenURL("https://example.com"); } catch(e) {} }, true)
          : "?";
        // Proxy/FFI: void(NSURL, block, block) — pass all 3 args directly
        const proxy = TurboModuleRegistry.getEnforcing("LinkingManager");
        const direct = global.__ferrumGetModule?.("LinkingManager");
        const proxyUs = bench(() => proxy.canOpenURL("https://example.com", noop, noop), true);
        const directUs = direct?.canOpenURL
          ? bench(() => direct.canOpenURL("https://example.com", noop, noop), true)
          : "N/A";
        return `JSI: ${jsiUs} · Proxy: ${proxyUs} · FFI: ${directUs} (${ASYNC_ROUNDS}×)`;
      },
    },
  ];

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Project Ferrum</Text>
      <Text style={styles.subtitle}>
        JSI vs Proxy vs FFI — μs/call
      </Text>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
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
      </ScrollView>

      <StatusBar style="light" />
    </View>
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
});
