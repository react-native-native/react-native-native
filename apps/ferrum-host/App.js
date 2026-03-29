import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';

// rust_add is a JS global registered by Ferrum via the Hermes C ABI.
// No import needed — it's on globalThis, registered before React boots.
const rustResult = global.rust_add(40, 2);

// Benchmark: 100K calls
let elapsed = 0;
const iterations = 100000;
const start = Date.now();
for (let i = 0; i < iterations; i++) {
  global.rust_add(i, i);
}
elapsed = Date.now() - start;
const usPerCall = ((elapsed * 1000) / iterations).toFixed(2);

export default function App() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Project Ferrum</Text>
      <Text style={styles.subtitle}>Rust-hosted Hermes inside Expo</Text>
      <View style={styles.resultBox}>
        <Text style={styles.result}>rust_add(40, 2) = {rustResult}</Text>
        <Text style={styles.benchmark}>
          {iterations} calls in {elapsed}ms{'\n'}
          {usPerCall} μs/call via Hermes C ABI
        </Text>
      </View>
      <StatusBar style="light" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1a1a2e',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  title: {
    fontSize: 32,
    fontWeight: '700',
    color: '#e94560',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    color: '#8888aa',
    marginBottom: 32,
  },
  resultBox: {
    backgroundColor: '#16213e',
    borderRadius: 12,
    padding: 24,
    width: '100%',
  },
  result: {
    fontSize: 24,
    fontFamily: 'Courier',
    color: '#4ecca3',
    textAlign: 'center',
    marginBottom: 12,
  },
  benchmark: {
    fontSize: 14,
    fontFamily: 'Courier',
    color: '#8888aa',
    textAlign: 'center',
    lineHeight: 22,
  },
});
