import { StatusBar } from "expo-status-bar";
import { useState, useEffect } from "react";
import { StyleSheet, Text, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

// --- Synchronous benchmarks (run at module load) ---

// Rust C ABI global
const rustResult = global.rust_add(40, 2);
const iterations = 100000;
let start = Date.now();
for (let i = 0; i < iterations; i++) global.rust_add(i, i);
const rustUs = (((Date.now() - start) * 1000) / iterations).toFixed(2);

// FerrumBench C ABI path
let abiResult = "not available";
let abiUs = "N/A";
try {
  if (global.__ferrumGetModule) {
    const abiBench = global.__ferrumGetModule("FerrumBench");
    if (abiBench) {
      abiResult = `add(40,2) = ${abiBench.add(40, 2)}`;
      start = Date.now();
      for (let i = 0; i < iterations; i++) abiBench.add(i, i);
      abiUs = (((Date.now() - start) * 1000) / iterations).toFixed(2);
    }
  }
} catch (e) {
  abiResult = `Error: ${e.message}`;
}

export default function App() {
  const [jsiStorage, setJsiStorage] = useState("testing...");
  const [abiStorage, setAbiStorage] = useState("testing...");

  useEffect(() => {
    testAsyncStorage();
  }, []);

  async function testAsyncStorage() {
    const testKey = "ferrum_bench";
    const testValue = `hello_${Date.now()}`;
    console.log("[Ferrum] testAsyncStorage starting");

    const rounds = 20;

    // Helper: callback-based set+get as a Promise
    function abiSetGet(mod, key, value) {
      return new Promise((resolve, reject) => {
        mod.multiSet([[key, value]], (...setArgs) => {
          mod.multiGet([key], (...getArgs) => {
            resolve(getArgs);
          });
        });
      });
    }

    // --- JSI path: standard AsyncStorage API ---
    try {
      // Warm up
      await AsyncStorage.setItem(testKey + "_jsi", testValue);
      await AsyncStorage.getItem(testKey + "_jsi");

      const jsiStart = Date.now();
      for (let i = 0; i < rounds; i++) {
        await AsyncStorage.setItem(testKey + "_jsi", testValue + i);
        await AsyncStorage.getItem(testKey + "_jsi");
      }
      const jsiMs = ((Date.now() - jsiStart) / rounds).toFixed(1);
      const jsiRead = await AsyncStorage.getItem(testKey + "_jsi");
      setJsiStorage(`"${jsiRead}" — ${jsiMs}ms avg (${rounds}x)`);
    } catch (e) {
      setJsiStorage(`Error: ${e.message}`);
    }

    // --- C ABI path: direct via __ferrumGetModule ---
    try {
      if (!global.__ferrumGetModule) {
        setAbiStorage("__ferrumGetModule not installed");
        return;
      }
      const abiMod = global.__ferrumGetModule("RNCAsyncStorage");
      if (!abiMod) {
        setAbiStorage("module not found");
        return;
      }

      // Warm up
      await abiSetGet(abiMod, testKey + "_abi", testValue);

      const abiStart = Date.now();
      for (let i = 0; i < rounds; i++) {
        await abiSetGet(abiMod, testKey + "_abi", testValue + i);
      }
      const abiMs = ((Date.now() - abiStart) / rounds).toFixed(1);
      const lastResult = await abiSetGet(abiMod, testKey + "_abi", "final");
      let readValue = "?";
      try {
        const result = lastResult[1];
        const first = result?.[0] || result?.["0"];
        readValue = first?.[1] || first?.["1"] || "?";
      } catch (e) {
        readValue = "parse error";
      }
      setAbiStorage(`"${readValue}" — ${abiMs}ms avg (${rounds}x)`);
    } catch (e) {
      setAbiStorage(`Error: ${e.message}`);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Project Ferrum</Text>
      <Text style={styles.subtitle}>Rust-hosted Hermes inside Expo</Text>

      <View style={styles.resultBox}>
        <Text style={styles.label}>Rust C ABI (global)</Text>
        <Text style={styles.result}>rust_add(40, 2) = {rustResult}</Text>
        <Text style={styles.benchmark}>{rustUs} μs/call</Text>
      </View>

      <View style={styles.resultBox}>
        <Text style={styles.label}>FerrumBench C ABI</Text>
        <Text style={styles.result}>{abiResult}</Text>
        <Text style={styles.benchmark}>{abiUs} μs/call</Text>
      </View>

      <View style={styles.resultBox}>
        <Text style={styles.label}>AsyncStorage — JSI path</Text>
        <Text style={styles.result}>{jsiStorage}</Text>
      </View>

      <View style={styles.resultBox}>
        <Text style={styles.label}>AsyncStorage — C ABI path</Text>
        <Text style={styles.result}>{abiStorage}</Text>
      </View>

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
    gap: 12,
  },
  title: {
    fontSize: 32,
    fontWeight: "700",
    color: "#e94560",
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 16,
    color: "#8888aa",
    marginBottom: 16,
  },
  resultBox: {
    backgroundColor: "#16213e",
    borderRadius: 12,
    padding: 16,
    width: "100%",
  },
  label: {
    fontSize: 12,
    fontWeight: "600",
    color: "#e94560",
    textTransform: "uppercase",
    marginBottom: 4,
  },
  result: {
    fontSize: 18,
    fontFamily: "Courier",
    color: "#4ecca3",
    textAlign: "center",
    marginBottom: 4,
  },
  benchmark: {
    fontSize: 14,
    fontFamily: "Courier",
    color: "#8888aa",
    textAlign: "center",
  },
});
