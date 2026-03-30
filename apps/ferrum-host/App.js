import { enableFerrum } from "./modules/expo-ferrum";
enableFerrum();

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

const iterations = 100000;
let benchUs = "N/A";
let start;
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
const ferrumVibration = global.__ferrumGetModule?.("Vibration");
const ferrumClipboard = global.__ferrumGetModule?.("Clipboard");
const ferrumAppState = global.__ferrumGetModule?.("AppState");

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

    // ABI — methods with callbacks are copied from JSI module
    let abiMs = "?";
    try {
      const m = global.__ferrumGetModule?.("RNCAsyncStorage");
      if (m && m.multiSet) {
        await abiSetGet(m, key + "_abi", val);
        const t = performance.now();
        for (let i = 0; i < rounds; i++) {
          await abiSetGet(m, key + "_abi", val + i);
        }
        abiMs = ((performance.now() - t) / rounds).toFixed(2);
      } else {
        abiMs = "N/A";
      }
    } catch (e) {
      abiMs = "err: " + e.message;
    }

    setStorageResult(`JSI: ${jsiMs}ms · ABI: ${abiMs}ms (${rounds}x)`);
  }

  function testVibration() {
    const rounds = 20;

    const jsiStart = performance.now();
    for (let i = 0; i < rounds; i++) Vibration.vibrate(1);
    const jsiUs = (((performance.now() - jsiStart) * 1000) / rounds).toFixed(1);

    let ferrumUs = "N/A";
    if (ferrumVibration) {
      const fStart = performance.now();
      for (let i = 0; i < rounds; i++) ferrumVibration.vibrate(1);
      ferrumUs = (((performance.now() - fStart) * 1000) / rounds).toFixed(1);
    }

    setVibrationResult(`JSI: ${jsiUs} · Ferrum: ${ferrumUs} μs`);
  }

  function testClipboard() {
    const rounds = 20;

    const jsiStart = performance.now();
    for (let i = 0; i < rounds; i++) Clipboard.setString("jsi_" + i);
    const jsiUs = (((performance.now() - jsiStart) * 1000) / rounds).toFixed(1);

    let ferrumUs = "N/A";
    if (ferrumClipboard) {
      const fStart = performance.now();
      for (let i = 0; i < rounds; i++) ferrumClipboard.setString("f_" + i);
      ferrumUs = (((performance.now() - fStart) * 1000) / rounds).toFixed(1);
    }

    setClipboardResult(`JSI: ${jsiUs} · Ferrum: ${ferrumUs} μs`);
  }

  function testAppState() {
    if (!ferrumAppState) {
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
      ferrumAppState.getCurrentAppState(
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
          FerrumBench.add: {benchUs}μs/call
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
