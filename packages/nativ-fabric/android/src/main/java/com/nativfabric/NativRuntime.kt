package com.nativfabric

import android.content.Context
import com.nativfabric.BuildConfig
import android.view.View
import android.view.ViewGroup
import dalvik.system.DexClassLoader
import java.io.File
import java.lang.reflect.Method
import java.util.concurrent.ConcurrentHashMap

/**
 * NativRuntime — native function registry, .so loader, and .dex loader.
 * Android equivalent of iOS's NativRuntime.
 *
 * Native (.so): render functions and sync functions registered via JNI
 * from loaded .so files (__attribute__((constructor))).
 *
 * Kotlin (.dex): loaded via DexClassLoader, dispatched via reflection.
 */
object NativRuntime {

    // Props snapshot: plain key-value maps (no JNI references)
    data class PropsSnapshot(
        val strings: Map<String, String> = emptyMap(),
        val numbers: Map<String, Double> = emptyMap(),
        val bools: Map<String, Boolean> = emptyMap(),
    )

    // Component props store
    private val propsStore = ConcurrentHashMap<String, PropsSnapshot>()

    // Loaded .so libraries
    private val loadedLibs = ConcurrentHashMap<String, Boolean>()

    // Loaded Kotlin modules: moduleId → dispatch Method
    private val kotlinDispatch = ConcurrentHashMap<String, Method>()

    // Loaded Kotlin Compose renderers: componentId → render Method
    private val kotlinRenderers = ConcurrentHashMap<String, Method>()

    // Application context (set from NativRuntimeModule)
    var appContext: Context? = null

    fun setComponentProps(componentId: String, props: PropsSnapshot) {
        propsStore[componentId] = props
    }

    fun getComponentProps(componentId: String): PropsSnapshot? {
        return propsStore[componentId]
    }

    fun tryRender(componentId: String, view: View, width: Float, height: Float) {
        // Check Kotlin renderers first (View-based components from .dex)
        val renderer = kotlinRenderers[componentId]
        if (renderer != null && view is ViewGroup) {
            try {
                val props = propsStore[componentId]
                val propsMap = mutableMapOf<String, Any?>()
                props?.strings?.forEach { (k, v) -> propsMap[k] = v }
                props?.numbers?.forEach { (k, v) -> propsMap[k] = v }
                props?.bools?.forEach { (k, v) -> propsMap[k] = v }
                renderer.invoke(null, view, propsMap)
                return
            } catch (e: Exception) {
                android.util.Log.e("NativRuntime", "Kotlin render failed: ${e.message}", e)
            }
        }

        // Fall back to native JNI render
        val props = propsStore[componentId]
        nativeTryRender(componentId, view, width, height,
            props?.strings ?: emptyMap(),
            props?.numbers ?: emptyMap(),
            props?.bools ?: emptyMap())
    }

    fun loadLibrary(path: String): Boolean {
        return try {
            System.load(path)
            loadedLibs[path] = true
            true
        } catch (e: UnsatisfiedLinkError) {
            android.util.Log.e("NativRuntime", "Failed to load $path: ${e.message}")
            false
        }
    }

    /**
     * Load a .dex file and register its module for dispatch.
     * The .dex must contain a class com.nativfabric.generated.NativModule_<moduleId>
     * with a static dispatch(String, String): String method.
     */
    fun loadDex(dexPath: String, moduleId: String): Boolean {
        // Production: Kotlin is compiled into the APK by Gradle — no DexClassLoader needed
        if (!BuildConfig.DEBUG) return false

        val ctx = appContext
        if (ctx == null) {
            android.util.Log.e("NativRuntime", "loadDex: appContext is null!")
            return false
        }
        return try {
            val dexFile = File(dexPath)
            val optimizedDir = File(ctx.cacheDir, "nativ_dex_opt")
            optimizedDir.mkdirs()

            // Android 14+ requires dex files to be read-only
            dexFile.setReadOnly()

            val loader = DexClassLoader(
                dexFile.absolutePath,
                optimizedDir.absolutePath,
                null,
                ctx.classLoader
            )

            val className = "com.nativfabric.generated.NativModule_$moduleId"
            val clazz = loader.loadClass(className)

            // Check for dispatch method (function module)
            try {
                val dispatch = clazz.getMethod("dispatch", String::class.java, String::class.java)
                kotlinDispatch[moduleId] = dispatch
                android.util.Log.i("NativRuntime", "Loaded Kotlin module: $moduleId")
            } catch (_: NoSuchMethodException) {}

            // Check for render method (Compose component)
            try {
                val render = clazz.getMethod("render", ViewGroup::class.java, Map::class.java)
                val componentId = "nativ.$moduleId"
                kotlinRenderers[componentId] = render
                android.util.Log.i("NativRuntime", "Loaded Kotlin component: $componentId")
            } catch (_: NoSuchMethodException) {}

            true
        } catch (e: Exception) {
            android.util.Log.e("NativRuntime", "loadDex failed: ${e.message}")
            false
        }
    }

    /**
     * Call a Kotlin function loaded from .dex.
     */
    fun callKotlin(moduleId: String, fnName: String, argsJson: String): String? {
        val dispatch = kotlinDispatch[moduleId] ?: return null
        return try {
            dispatch.invoke(null, fnName, argsJson) as? String
        } catch (e: Exception) {
            android.util.Log.e("NativRuntime", "callKotlin failed: $moduleId::$fnName: ${e.message}")
            null
        }
    }

    // JNI functions — implemented in C++ (libnativruntime.so)
    external fun nativeInit()
    external fun nativeTryRender(
        componentId: String, view: View, width: Float, height: Float,
        strings: Map<String, String>, numbers: Map<String, Double>, bools: Map<String, Boolean>
    )
    external fun nativeCallSync(moduleId: String, fnName: String, argsJson: String): String?

    init {
        try {
            System.loadLibrary("nativruntime")
            nativeInit()
        } catch (e: UnsatisfiedLinkError) {
            android.util.Log.w("NativRuntime", "nativruntime not loaded: ${e.message}")
        }

        // Production: register Kotlin modules compiled into the APK by Gradle.
        // In dev mode, modules are loaded via DexClassLoader (loadDex).
        if (!BuildConfig.DEBUG) {
            try {
                Class.forName("com.nativfabric.generated.NativModuleRegistry")
                    .getMethod("ensure")
                    .invoke(null)
                android.util.Log.i("NativRuntime", "Production: Kotlin module registry loaded")
            } catch (e: ClassNotFoundException) {
                // No generated modules — that's fine
            } catch (e: Exception) {
                android.util.Log.w("NativRuntime", "Kotlin registry failed: ${e.message}")
            }
        }
    }

    /** Register a Kotlin dispatch method (production — called by generated NativModuleRegistry) */
    @JvmStatic
    fun registerKotlinDispatch(moduleId: String, dispatch: java.lang.reflect.Method) {
        kotlinDispatch[moduleId] = dispatch
        android.util.Log.i("NativRuntime", "Production: registered Kotlin dispatch: $moduleId")
    }

    /** Register a Kotlin renderer method (production — called by generated NativModuleRegistry) */
    @JvmStatic
    fun registerKotlinRenderer(componentId: String, render: java.lang.reflect.Method) {
        kotlinRenderers[componentId] = render
        android.util.Log.i("NativRuntime", "Production: registered Kotlin renderer: $componentId")
    }
}
