package com.nativfabric

import com.facebook.proguard.annotations.DoNotStrip
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.turbomodule.core.interfaces.BindingsInstallerHolder
import com.facebook.react.turbomodule.core.interfaces.TurboModuleWithJSIBindings

/**
 * TurboModule that installs global.__nativ JSI bindings when loaded.
 * Uses TurboModuleWithJSIBindings — RN calls installJSIBindingsWithRuntime
 * automatically when the module is first accessed from JS.
 *
 * No BindingsInstaller on MainApplication.kt needed.
 * No dependency on the old expo-ferrum module.
 */
@DoNotStrip
@ReactModule(name = NativRuntimeModule.NAME)
class NativRuntimeModule(context: ReactApplicationContext) :
    NativeNativRuntimeSpec(context), TurboModuleWithJSIBindings {

    override fun getConstants(): Map<String, Any> = emptyMap()

    @DoNotStrip
    external override fun getBindingsInstaller(): BindingsInstallerHolder

    override fun getName(): String = NAME

    companion object {
        const val NAME = "NativRuntime"

        init {
            System.loadLibrary("nativruntime")
        }
    }
}
