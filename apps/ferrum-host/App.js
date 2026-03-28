import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';
import ExpoFerrum from './modules/expo-ferrum';

export default function App() {
  const result = ExpoFerrum.getBenchmarkResult();

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Project Ferrum</Text>
      <Text style={styles.subtitle}>Rust-hosted Hermes V1 inside Expo</Text>
      <View style={styles.resultBox}>
        <Text style={styles.result}>{result}</Text>
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
    fontSize: 18,
    fontFamily: 'Courier',
    color: '#0f3460',
    color: '#4ecca3',
    textAlign: 'center',
  },
});
