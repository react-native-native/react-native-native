import { StatusBar } from "expo-status-bar";
import { useState, useEffect } from "react";
import {
  StyleSheet,
  Text,
  View,
  Vibration,
  Clipboard,
  Pressable,
  AppState,
  NativeModules,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

// --- Synchronous benchmarks (run at module load) ---

const rustResult = global.rust_add(40, 2);
const iterations = 100000;
let start = performance.now();
for (let i = 0; i < iterations; i++) global.rust_add(i, i);
const rustUs = (((performance.now() - start) * 1000) / iterations).toFixed(2);

let benchUs = "N/A";
try {
  const abiBench = global.__ferrumGetModule?.("FerrumBench");
  if (abiBench) {
    start = performance.now();
    for (let i = 0; i < iterations; i++) abiBench.add(i, i);
    benchUs = (((performance.now() - start) * 1000) / iterations).toFixed(2);
  }
} catch (e) {}

// --- C ABI modules ---
let cachedV1Bench = null;
let cachedV2Bench = null;
const abiVibration = global.__ferrumGetModule?.("Vibration");
const abiClipboard = global.__ferrumGetModule?.("Clipboard");
const abiAppState = global.__ferrumGetModule?.("AppState");

// V2: passthrough (reuses existing hostFn, no type reimplementation)
const v2Vibration = global.__ferrumGetModuleV2?.("Vibration");
const v2Clipboard = global.__ferrumGetModuleV2?.("Clipboard");

export default function App() {
  const [storageResult, setStorageResult] = useState("testing...");
  const [vibrationResult, setVibrationResult] = useState("tap to test");
  const [clipboardResult, setClipboardResult] = useState("tap to test");
  const [appStateResult, setAppStateResult] = useState("tap to test");

  useEffect(() => {
    testAsyncStorage();
  }, []);

  async function testAsyncStorage() {
    const rounds = 20;
    const key = "ferrum_bench";
    const val = "test_value";

    function abiSetGet(mod, k, v) {
      return new Promise((resolve) => {
        mod.multiSet([[k, v]], () => {
          mod.multiGet([k], (...args) => resolve(args));
        });
      });
    }

    // JSI
    let jsiMs = "?";
    try {
      await AsyncStorage.setItem(key + "_jsi", val);
      await AsyncStorage.getItem(key + "_jsi");
      const t = performance.now();
      for (let i = 0; i < rounds; i++) {
        await AsyncStorage.setItem(key + "_jsi", val + i);
        await AsyncStorage.getItem(key + "_jsi");
      }
      jsiMs = ((performance.now() - t) / rounds).toFixed(1);
    } catch (e) {
      jsiMs = "err";
    }

    // ABI
    let abiMs = "?";
    try {
      const m = global.__ferrumGetModule?.("RNCAsyncStorage");
      if (m) {
        await abiSetGet(m, key + "_abi", val);
        const t = performance.now();
        for (let i = 0; i < rounds; i++) {
          await abiSetGet(m, key + "_abi", val + i);
        }
        abiMs = ((performance.now() - t) / rounds).toFixed(1);
      }
    } catch (e) {
      abiMs = "err";
    }

    setStorageResult(`JSI: ${jsiMs}ms · ABI: ${abiMs}ms (${rounds}x)`);
  }

  function testVibration() {
    const rounds = 20;

    const jsiStart = performance.now();
    for (let i = 0; i < rounds; i++) Vibration.vibrate(1);
    const jsiUs = (((performance.now() - jsiStart) * 1000) / rounds).toFixed(1);

    let abiUs = "N/A";
    if (abiVibration) {
      const abiStart = performance.now();
      for (let i = 0; i < rounds; i++) abiVibration.vibrate(1);
      abiUs = (((performance.now() - abiStart) * 1000) / rounds).toFixed(1);
    }

    let v2Us = "N/A";
    if (v2Vibration) {
      const v2Start = performance.now();
      for (let i = 0; i < rounds; i++) v2Vibration.vibrate(1);
      v2Us = (((performance.now() - v2Start) * 1000) / rounds).toFixed(1);
    }

    setVibrationResult(`JSI: ${jsiUs} · V1: ${abiUs} · V2: ${v2Us} μs`);
  }

  function testClipboard() {
    const rounds = 20;

    const jsiStart = performance.now();
    for (let i = 0; i < rounds; i++) Clipboard.setString("jsi_" + i);
    const jsiUs = (((performance.now() - jsiStart) * 1000) / rounds).toFixed(1);

    let abiUs = "N/A";
    if (abiClipboard) {
      const abiStart = performance.now();
      for (let i = 0; i < rounds; i++) abiClipboard.setString("abi_" + i);
      abiUs = (((performance.now() - abiStart) * 1000) / rounds).toFixed(1);
    }

    let v2Us = "N/A";
    if (v2Clipboard) {
      const v2Start = performance.now();
      for (let i = 0; i < rounds; i++) v2Clipboard.setString("v2_" + i);
      v2Us = (((performance.now() - v2Start) * 1000) / rounds).toFixed(1);
    }

    setClipboardResult(`JSI: ${jsiUs} · V1: ${abiUs} · V2: ${v2Us} μs`);
  }

  function testAppState() {
    if (!abiAppState) {
      setAppStateResult("module not found");
      return;
    }

    const rounds = 20;
    let completed = 0;
    let jsiTotal = 0;
    let abiTotal = 0;

    // Run both in sequence
    function runJSI(i) {
      if (i >= rounds) {
        runABI(0);
        return;
      }
      const t = performance.now();
      // JSI: AppState.currentState is sync
      const _ = AppState.currentState;
      jsiTotal += performance.now() - t;
      runJSI(i + 1);
    }

    function runABI(i) {
      if (i >= rounds) {
        const jsiUs = ((jsiTotal * 1000) / rounds).toFixed(1);
        const abiUs = ((abiTotal * 1000) / rounds).toFixed(1);
        setAppStateResult(`JSI: ${jsiUs}μs · ABI: ${abiUs}μs (${rounds}x)`);
        return;
      }
      const t = performance.now();
      abiAppState.getCurrentAppState(
        (state) => {
          abiTotal += performance.now() - t;
          runABI(i + 1);
        },
        () => {
          abiTotal += performance.now() - t;
          runABI(i + 1);
        }
      );
    }

    runJSI(0);
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Project Ferrum</Text>
      <Text style={styles.subtitle}>C ABI TurboModule Bridges</Text>

      <View style={styles.resultBox}>
        <Text style={styles.label}>Sync (100K calls)</Text>
        <Text style={styles.result}>
          Rust: {rustUs}μs · Bench: {benchUs}μs
        </Text>
      </View>

      <View style={styles.resultBox}>
        <Text style={styles.label}>AsyncStorage (set+get)</Text>
        <Text style={styles.result}>{storageResult}</Text>
      </View>

      <Pressable style={styles.resultBox} onPress={testVibration}>
        <Text style={styles.label}>Vibration.vibrate(1) — tap</Text>
        <Text style={styles.result}>{vibrationResult}</Text>
      </Pressable>

      <Pressable style={styles.resultBox} onPress={testClipboard}>
        <Text style={styles.label}>Clipboard.setString() — tap</Text>
        <Text style={styles.result}>{clipboardResult}</Text>
      </Pressable>

      <Pressable style={styles.resultBox} onPress={testAppState}>
        <Text style={styles.label}>AppState — tap</Text>
        <Text style={styles.result}>{appStateResult}</Text>
      </Pressable>

      <StatusBar style="light" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#1a1a2e",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    gap: 10,
  },
  title: {
    fontSize: 28,
    fontWeight: "700",
    color: "#e94560",
    marginBottom: 2,
  },
  subtitle: {
    fontSize: 14,
    color: "#8888aa",
    marginBottom: 12,
  },
  resultBox: {
    backgroundColor: "#16213e",
    borderRadius: 12,
    padding: 14,
    width: "100%",
  },
  label: {
    fontSize: 11,
    fontWeight: "600",
    color: "#e94560",
    textTransform: "uppercase",
    marginBottom: 4,
  },
  result: {
    fontSize: 15,
    fontFamily: "Courier",
    color: "#4ecca3",
    textAlign: "center",
  },
});
