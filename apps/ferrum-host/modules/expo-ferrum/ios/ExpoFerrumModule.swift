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

public class ExpoFerrumAppDelegateSubscriber: BaseExpoAppDelegateSubscriber, ExpoAppDelegateSubscriberProtocol {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    NSLog("[Ferrum] AppDelegateSubscriber: didFinishLaunchingWithOptions")

    let result = ferrum_bridge_init()
    let resultString = String(cString: result)
    NSLog("[Ferrum] ferrum_bridge_init returned: \(resultString)")

    FerrumBridge.shared.benchmarkResult = resultString
    ferrum_bridge_free_string(result)

    return true
  }
}

class FerrumBridge {
  static let shared = FerrumBridge()
  var benchmarkResult: String = "not initialized"
  var callOverheadMicros: Double = -1.0
}

@_silgen_name("ferrum_bridge_init")
func ferrum_bridge_init() -> UnsafeMutablePointer<CChar>

@_silgen_name("ferrum_bridge_free_string")
func ferrum_bridge_free_string(_ ptr: UnsafeMutablePointer<CChar>)
