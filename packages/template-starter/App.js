import { StatusBar } from "expo-status-bar";
import { StyleSheet, Text, View } from "react-native";
import { add, greet } from "./hello";

export default function App() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>React Native Native</Text>
      <Text style={styles.subtitle}>Edit hello.cpp and save to hot-reload</Text>
      <View style={styles.card}>
        <Text style={styles.result}>add(2, 3) = {String(add(2, 3))}</Text>
        <Text style={styles.result}>{greet("World")}</Text>
      </View>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },
  title: {
    fontSize: 24,
    fontWeight: "bold",
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: "#666",
    marginBottom: 24,
  },
  card: {
    backgroundColor: "#f5f5f5",
    borderRadius: 12,
    padding: 20,
    width: "100%",
    alignItems: "center",
  },
  result: {
    fontSize: 16,
    marginVertical: 4,
  },
});
