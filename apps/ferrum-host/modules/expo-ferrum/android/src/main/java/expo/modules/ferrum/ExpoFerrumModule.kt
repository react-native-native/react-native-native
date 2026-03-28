package expo.modules.ferrum

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ExpoFerrumModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ExpoFerrum")

    Function("getBenchmarkResult") {
      // Phase 1: call into Rust via JNI
      "not yet initialized (Android)"
    }

    Function("getCallOverheadMicros") {
      -1.0
    }
  }
}
