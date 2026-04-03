package com.nativfabric

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider
import com.facebook.react.uimanager.ViewManager

class NativContainerPackage : BaseReactPackage() {
    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> {
        // Ensure NativRuntime has app context for DexClassLoader
        if (NativRuntime.appContext == null) {
            NativRuntime.appContext = reactContext.applicationContext
        }
        return listOf(NativContainerViewManager())
    }

    override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? {
        return when (name) {
            NativRuntimeModule.NAME -> NativRuntimeModule(reactContext)
            NativRuntimeModule.NAME -> NativRuntimeModule(reactContext)
            else -> null
        }
    }

    override fun getReactModuleInfoProvider() = ReactModuleInfoProvider {
        mapOf(
            NativRuntimeModule.NAME to ReactModuleInfo(
                NativRuntimeModule.NAME,
                NativRuntimeModule.NAME,
                false, false, false, false, true
            ),
            NativRuntimeModule.NAME to ReactModuleInfo(
                NativRuntimeModule.NAME,
                NativRuntimeModule.NAME,
                false, false, false, false, true
            )
        )
    }
}
