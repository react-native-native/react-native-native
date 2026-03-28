import ExpoModulesCore

public class ExpoFerrumModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoFerrum")

    // Expose ferrum_init result to JS
    Function("getBenchmarkResult") {
      return FerrumBridge.shared.benchmarkResult
    }

    Function("getCallOverheadMicros") {
      return FerrumBridge.shared.callOverheadMicros
    }
  }
}

/// AppDelegate lifecycle hook — called before RCTHost creates the React instance.
/// This is where Ferrum inserts its orchestration.
public class ExpoFerrumAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func applicationDidFinishLaunching(_ application: UIApplication) {
    NSLog("[Ferrum] ExpoAppDelegateSubscriber: applicationDidFinishLaunching")

    // Phase 1: This is where we'd call ferrum_init() to:
    //   1. get_hermes_abi_vtable() → makeHermesABIRuntimeWrapper() → jsi::Runtime
    //   2. Create Scheduler with the existing Fabric C++
    //   3. Register fast-path Rust functions
    //
    // For now, call the Phase 0 proof via our Rust static library to verify
    // the FFI bridge works inside an Expo module context.
    let result = ferrum_bridge_init()
    NSLog("[Ferrum] ferrum_bridge_init returned: \(result)")

    FerrumBridge.shared.benchmarkResult = String(cString: result)
    ferrum_bridge_free_string(result)
  }
}

/// Shared state between the AppDelegate subscriber and the JS module.
class FerrumBridge {
  static let shared = FerrumBridge()
  var benchmarkResult: String = "not initialized"
  var callOverheadMicros: Double = -1.0
}

// ---------------------------------------------------------------------------
// Rust FFI declarations — links against libferrum_host.a
// ---------------------------------------------------------------------------

/// Initialize the Ferrum runtime: boot Hermes, register rust_add, evaluate
/// the test bundle, run benchmark. Returns a C string with the result.
/// Caller must free with ferrum_bridge_free_string().
@_silgen_name("ferrum_bridge_init")
func ferrum_bridge_init() -> UnsafeMutablePointer<CChar>

/// Free a string returned by ferrum_bridge_init.
@_silgen_name("ferrum_bridge_free_string")
func ferrum_bridge_free_string(_ ptr: UnsafeMutablePointer<CChar>)
