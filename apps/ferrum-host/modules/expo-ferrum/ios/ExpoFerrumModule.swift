import ExpoModulesCore

public class ExpoFerrumModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoFerrum")

    Function("getBenchmarkResult") {
      return FerrumBridge.shared.benchmarkResult
    }

    // OnCreate fires when the module is loaded.
    // The runtime may not be available yet, but we can set up state.
    OnCreate {
      NSLog("[Ferrum] ExpoFerrumModule OnCreate")
      FerrumBridge.shared.benchmarkResult = "Ferrum active — waiting for runtime"
    }
  }
}

/// AppDelegate lifecycle hook.
/// didInitializeRuntime fires BEFORE bundle evaluation with jsi::Runtime&.
public class ExpoFerrumAppDelegateSubscriber: BaseExpoAppDelegateSubscriber, ExpoAppDelegateSubscriberProtocol {

  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    NSLog("[Ferrum] AppDelegateSubscriber: didFinishLaunchingWithOptions")
    // Runtime registration happens in didInitializeRuntime via the
    // ExpoReactNativeFactory's RCTHostRuntimeDelegate callback.
    // We just mark that Ferrum is active.
    FerrumBridge.shared.benchmarkResult = "Ferrum orchestrator active — Hermes C ABI"
    return true
  }
}

class FerrumBridge {
  static let shared = FerrumBridge()
  var benchmarkResult: String = "not initialized"
  var callOverheadMicros: Double = -1.0
}

// Ferrum C FFI
@_silgen_name("ferrum_install_abi_module_getter")
func ferrum_install_abi_module_getter(_ runtime: UnsafeMutableRawPointer)
