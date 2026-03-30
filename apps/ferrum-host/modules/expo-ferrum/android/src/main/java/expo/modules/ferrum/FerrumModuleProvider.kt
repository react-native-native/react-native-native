package expo.modules.ferrum

import android.os.Handler
import android.os.HandlerThread
import com.facebook.proguard.annotations.DoNotStrip
import com.facebook.react.runtime.ReactHostImpl

/**
 * Provides Java TurboModule instances and a native worker thread to the C++ Ferrum layer.
 */
@DoNotStrip
object FerrumModuleProvider {
    private var reactHost: ReactHostImpl? = null

    // Dedicated worker thread for async void method dispatch.
    // Serial, ordered — same semantics as RN's nativeMethodCallInvoker.
    private val workerThread = HandlerThread("FerrumNativeWorker").apply { start() }
    private val workerHandler = Handler(workerThread.looper)

    fun setReactHost(host: ReactHostImpl) {
        reactHost = host
    }

    @JvmStatic
    @DoNotStrip
    fun getModuleInstance(moduleName: String): Any? {
        try {
            val context = reactHost?.currentReactContext ?: return null
            return context.getNativeModule(moduleName)
        } catch (e: Exception) {
            return null
        }
    }

    @JvmStatic
    @DoNotStrip
    fun postToWorker(runnable: Runnable) {
        workerHandler.post(runnable)
    }
}
