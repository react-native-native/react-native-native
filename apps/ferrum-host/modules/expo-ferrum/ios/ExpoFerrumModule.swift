import ExpoModulesCore

public class ExpoFerrumModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoFerrum")

    Function("getBenchmarkResult") {
      return FerrumBridge.shared.benchmarkResult
    }

    Function("getCallOverheadMicros") {
      return FerrumBridge.shared.callOverheadMicros
    }
  }
}

/// AppDelegate lifecycle hook — intercepts createJSRuntimeFactory to inject
/// FerrumRuntimeFactory instead of the default HermesInstance.
public class ExpoFerrumAppDelegateSubscriber: BaseExpoAppDelegateSubscriber, ExpoAppDelegateSubscriberProtocol {

  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    NSLog("[Ferrum] AppDelegateSubscriber: didFinishLaunchingWithOptions")
    NSLog("[Ferrum] FerrumRuntimeFactory will be injected via createJSRuntimeFactory override")

    FerrumBridge.shared.benchmarkResult = "Ferrum orchestrator active — Hermes V1 C ABI"
    return true
  }

  /// Override createJSRuntimeFactory to return FerrumRuntimeFactory.
  /// This is the orchestrator injection point — Ferrum creates Hermes via
  /// the C ABI, registers Rust fn ptrs, then wraps as jsi::Runtime.
  @objc public func createJSRuntimeFactory() -> UnsafeMutableRawPointer {
    NSLog("[Ferrum] createJSRuntimeFactory: returning FerrumRuntimeFactory")
    return jsrt_create_ferrum_factory()
  }
}

class FerrumBridge {
  static let shared = FerrumBridge()
  var benchmarkResult: String = "not initialized"
  var callOverheadMicros: Double = -1.0
}

// C FFI declarations
@_silgen_name("ferrum_bridge_init")
func ferrum_bridge_init() -> UnsafeMutablePointer<CChar>

@_silgen_name("ferrum_bridge_free_string")
func ferrum_bridge_free_string(_ ptr: UnsafeMutablePointer<CChar>)

@_silgen_name("jsrt_create_ferrum_factory")
func jsrt_create_ferrum_factory() -> UnsafeMutableRawPointer
