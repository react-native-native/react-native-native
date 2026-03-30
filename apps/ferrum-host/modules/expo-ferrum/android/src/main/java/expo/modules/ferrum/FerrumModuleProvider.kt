package expo.modules.ferrum

import com.facebook.proguard.annotations.DoNotStrip
import com.facebook.react.ReactApplication
import com.facebook.react.runtime.ReactHostImpl

/**
 * Provides Java TurboModule instances to the C++ Ferrum layer.
 * Uses the ReactHost's TurboModuleManager to look up modules by name.
 */
@DoNotStrip
object FerrumModuleProvider {
    private var reactHost: ReactHostImpl? = null

    fun setReactHost(host: ReactHostImpl) {
        reactHost = host
    }

    @JvmStatic
    @DoNotStrip
    fun getModuleInstance(moduleName: String): Any? {
        try {
            val host = reactHost
            if (host == null) {
                android.util.Log.w("Ferrum", "getModuleInstance($moduleName): reactHost is null")
                return null
            }
            val context = host.currentReactContext
            if (context == null) {
                android.util.Log.w("Ferrum", "getModuleInstance($moduleName): reactContext is null")
                return null
            }
            val module = context.getNativeModule(moduleName)
            android.util.Log.i("Ferrum", "getModuleInstance($moduleName): ${module?.javaClass?.name ?: "null"}")
            return module
        } catch (e: Exception) {
            android.util.Log.e("Ferrum", "getModuleInstance($moduleName): ${e.message}")
            return null
        }
    }
}
