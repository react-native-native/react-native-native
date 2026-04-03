import { StatusBar } from "expo-status-bar";
import { useState } from "react";
import { StyleSheet, Text, View, Pressable, ScrollView } from "react-native";

// Cross-platform native code
import HelloRust from "./components/native/HelloRust";
import { add, fast_inv_sqrt, greet } from "./components/native/math_utils";
import { fibonacci, is_prime, greet_rust } from "./components/native/rust_math";
import { slowGreetCpp, heavyComputeCpp } from "./components/native/async_utils";

// iOS-only native code
import GradientBox from "./components/native/GradientBox";
import SwiftCounter from "./components/native/SwiftCounter";
import {
  getColorScheme,
  getScreenBrightness,
  getDeviceModel,
  getStatusBarHeight,
} from "./components/native/device_info";
import { tapLight, tapMedium, tapHeavy, notifySuccess } from "./components/native/haptics";
import { deviceName, systemVersion, batteryLevel } from "./components/native/platform_info";
import { slowGreet, heavyCompute, fetchURL } from "./components/native/async_demo";

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
        {loading ? "loading..." : result || "tap to test"}
      </Text>
    </Pressable>
  );
}

export default function App() {
  return (
    <ScrollView style={styles.container}>
      <Text style={styles.title}>React Native Native</Text>
      <Text style={styles.subtitle}>Native code, hot-reloaded</Text>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>Rust Component</Text>
        <HelloRust
          style={{ width: "100%", height: 100 }}
          text="Props directly from JS!"
          r={0.1}
          g={0.9}
          b={0.9}
        />
      </View>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>ObjC++ Component (CAGradientLayer)</Text>
        <GradientBox
          style={{ width: "100%", height: 70, borderRadius: 12, overflow: "hidden" }}
          title="Props from JS!"
          cornerRadius={18}
        />
      </View>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>SwiftUI Component</Text>
        <SwiftCounter
          style={{ width: "100%", height: 80, borderRadius: 12, overflow: "hidden" }}
          title="Hello from SwiftUI!"
          color="#ffcc99"
        />
      </View>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>C++ Functions</Text>
        <Text style={styles.result}>add(2, 3) = {String(add(2, 3))}</Text>
        <Text style={styles.result}>fast_inv_sqrt(4) = {String(fast_inv_sqrt(4))}</Text>
        <Text style={styles.result}>{greet("Nativ")}</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>Rust Functions</Text>
        <Text style={styles.result}>fibonacci(10) = {String(fibonacci(10))}</Text>
        <Text style={styles.result}>is_prime(97) = {String(is_prime(97))}</Text>
        <Text style={styles.result}>{greet_rust("Nativ")}</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>Swift Functions</Text>
        <Text style={styles.result}>device: {deviceName()}</Text>
        <Text style={styles.result}>os: {systemVersion()}</Text>
        <Text style={styles.result}>battery: {String(batteryLevel())}</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>ObjC++ — iOS Platform APIs</Text>
        <Text style={styles.result}>colorScheme: {getColorScheme()}</Text>
        <Text style={styles.result}>brightness: {getScreenBrightness().toFixed(2)}</Text>
        <Text style={styles.result}>device: {getDeviceModel()}</Text>
        <Text style={styles.result}>statusBar: {getStatusBarHeight()}px</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>ObjC++ — Haptic Feedback</Text>
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

      <View style={styles.card}>
        <Text style={styles.cardLabel}>Async Functions (C++)</Text>
        <AsyncButton label="slowGreetCpp('World')" onPress={() => slowGreetCpp("World")} />
        <AsyncButton label="heavyComputeCpp(40)" onPress={() => heavyComputeCpp(40)} />
      </View>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>Async Functions (ObjC++)</Text>
        <AsyncButton label="slowGreet('World')" onPress={() => slowGreet("World")} />
        <AsyncButton label="heavyCompute(40)" onPress={() => heavyCompute(40)} />
        <AsyncButton label="fetchURL (httpbin)" onPress={() => fetchURL("https://httpbin.org/get")} />
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
  card: {
    backgroundColor: "#16213e",
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    overflow: "hidden",
  },
  cardLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: "#e94560",
    marginBottom: 8,
  },
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
  result: {
    fontSize: 14,
    fontFamily: "Courier",
    color: "#4ecca3",
    textAlign: "center",
  },
});
