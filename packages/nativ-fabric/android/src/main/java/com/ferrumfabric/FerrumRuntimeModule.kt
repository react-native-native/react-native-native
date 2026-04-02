package com.nativfabric

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.bridge.ReactContextBaseJavaModule
import java.io.File
import java.io.FileOutputStream
import java.net.URL

/**
 * FerrumRuntimeModule — TurboModule exposing __rna to JS on Android.
 * Handles callSync, setComponentProps, loadDylib (.so), loadDex (.dex for Kotlin).
 */
@ReactModule(name = FerrumRuntimeModule.NAME)
class FerrumRuntimeModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    init {
        // Provide app context for DexClassLoader
        FerrumRuntime.appContext = reactContext.applicationContext
        instance = this
    }

    override fun getName(): String = NAME

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun callSync(moduleId: String, fnName: String, argsJson: String): String? {
        // Try Kotlin dispatch first, then native
        val ktResult = FerrumRuntime.callKotlin(moduleId, fnName, argsJson)
        if (ktResult != null) return ktResult
        return FerrumRuntime.nativeCallSync(moduleId, fnName, argsJson)
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun setComponentProps(componentId: String, props: ReadableMap) {
        val strings = mutableMapOf<String, String>()
        val numbers = mutableMapOf<String, Double>()
        val bools = mutableMapOf<String, Boolean>()

        val iterator = props.keySetIterator()
        while (iterator.hasNextKey()) {
            val key = iterator.nextKey()
            when (props.getType(key)) {
                com.facebook.react.bridge.ReadableType.String ->
                    strings[key] = props.getString(key) ?: ""
                com.facebook.react.bridge.ReadableType.Number ->
                    numbers[key] = props.getDouble(key)
                com.facebook.react.bridge.ReadableType.Boolean ->
                    bools[key] = props.getBoolean(key)
                else -> {} // skip functions, objects for now
            }
        }

        FerrumRuntime.setComponentProps(componentId,
            FerrumRuntime.PropsSnapshot(strings, numbers, bools))
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun loadDylib(url: String): Boolean {
        return try {
            val ext = if (url.contains(".dex")) "dex" else "so"

            // Download from Metro dev server
            val bytes = URL(url).readBytes()
            val cacheDir = reactApplicationContext.cacheDir
            val libDir = File(cacheDir, "nativ_libs")
            libDir.mkdirs()
            val libFile = File(libDir, "rna_${System.currentTimeMillis()}.$ext")
            FileOutputStream(libFile).use { it.write(bytes) }

            if (ext == "dex") {
                // Extract moduleId from URL: /__nativ_dylib/moduleid.dex?v=...
                val moduleId = url.substringAfterLast("/")
                    .substringBefore(".dex")
                    .removePrefix("nativ_")
                FerrumRuntime.loadDex(libFile.absolutePath, moduleId)
            } else {
                libFile.setExecutable(true)
                FerrumRuntime.loadLibrary(libFile.absolutePath)
            }
        } catch (e: Exception) {
            android.util.Log.e("FerrumRuntime", "loadDylib failed: ${e.message}")
            false
        }
    }

    companion object {
        const val NAME = "FerrumRuntime"

        // Static instance for JNI access from FerrumBindings.cpp
        private var instance: FerrumRuntimeModule? = null

        @JvmStatic
        fun loadDylibStatic(url: String): Boolean {
            val inst = instance ?: return false
            return inst.loadDylib(url)
        }
    }
}
