package expo.modules.ferrum

import com.facebook.jni.HybridData
import com.facebook.proguard.annotations.DoNotStrip
import com.facebook.react.runtime.BindingsInstaller
import com.facebook.soloader.SoLoader

@DoNotStrip
class FerrumBindingsInstaller : BindingsInstaller(initHybrid()) {
    companion object {
        init {
            SoLoader.loadLibrary("ferrum")
        }

        @JvmStatic
        private external fun initHybrid(): HybridData
    }
}
