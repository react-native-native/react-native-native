package com.nativfabric

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider
import com.facebook.react.uimanager.ViewManager

class FerrumContainerPackage : BaseReactPackage() {
    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> {
        // Ensure FerrumRuntime has app context for DexClassLoader
        if (FerrumRuntime.appContext == null) {
            FerrumRuntime.appContext = reactContext.applicationContext
        }
        return listOf(FerrumContainerViewManager())
    }

    override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? {
        return when (name) {
            FerrumRuntimeModule.NAME -> FerrumRuntimeModule(reactContext)
            RNARuntimeModule.NAME -> RNARuntimeModule(reactContext)
            else -> null
        }
    }

    override fun getReactModuleInfoProvider() = ReactModuleInfoProvider {
        mapOf(
            FerrumRuntimeModule.NAME to ReactModuleInfo(
                FerrumRuntimeModule.NAME,
                FerrumRuntimeModule.NAME,
                false, false, false, false, true
            ),
            RNARuntimeModule.NAME to ReactModuleInfo(
                RNARuntimeModule.NAME,
                RNARuntimeModule.NAME,
                false, false, false, false, true
            )
        )
    }
}
