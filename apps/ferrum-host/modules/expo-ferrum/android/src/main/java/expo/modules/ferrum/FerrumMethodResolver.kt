package expo.modules.ferrum

import com.facebook.proguard.annotations.DoNotStrip
import com.facebook.react.bridge.Callback
import com.facebook.react.bridge.Dynamic
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.facebook.react.turbomodule.core.interfaces.TurboModule

/**
 * Resolves method metadata for TurboModules at module creation time.
 * Same logic as RN's TurboModuleInteropUtils but exposed for Ferrum's use.
 * Runs once per module — not on the hot path.
 */
@DoNotStrip
object FerrumMethodResolver {

    @DoNotStrip
    class MethodInfo(
        @JvmField val name: String,
        @JvmField val jniSignature: String,
        @JvmField val returnKind: Int,    // 0=void, 1=boolean, 2=number, 3=string, 4=object, 5=array, 6=promise
        @JvmField val jsArgCount: Int,
    )

    // Return kind constants matching TurboModuleMethodValueKind
    const val VOID = 0
    const val BOOLEAN = 1
    const val NUMBER = 2
    const val STRING = 3
    const val OBJECT = 4
    const val ARRAY = 5
    const val PROMISE = 6

    @JvmStatic
    @DoNotStrip
    fun resolveMethodsForClass(moduleClass: Class<*>): Array<MethodInfo> {
        // For spec-based modules, inspect the spec superclass
        var cls: Class<*> = moduleClass
        val superClass = cls.superclass
        if (superClass != null && TurboModule::class.java.isAssignableFrom(superClass)) {
            cls = superClass
        }

        val results = mutableListOf<MethodInfo>()
        val seen = mutableSetOf<String>()

        for (method in cls.declaredMethods) {
            val annotation = method.getAnnotation(ReactMethod::class.java)
            val name = method.name
            if (annotation == null && name != "getConstants") continue
            if (!seen.add(name)) continue

            val paramTypes = method.parameterTypes
            val returnType = method.returnType

            val jniSig = buildJniSignature(paramTypes, returnType)
            val returnKind = resolveReturnKind(paramTypes, returnType)
            val jsArgCount = if (paramTypes.isNotEmpty() && paramTypes.last() == Promise::class.java)
                paramTypes.size - 1 else paramTypes.size

            results.add(MethodInfo(name, jniSig, returnKind, jsArgCount))
        }

        return results.toTypedArray()
    }

    private fun buildJniSignature(paramTypes: Array<Class<*>>, returnType: Class<*>): String {
        val sb = StringBuilder("(")
        for (p in paramTypes) sb.append(classToJni(p))
        sb.append(")")
        sb.append(returnClassToJni(returnType))
        return sb.toString()
    }

    private fun classToJni(cls: Class<*>): String = when (cls) {
        Boolean::class.javaPrimitiveType -> "Z"
        Int::class.javaPrimitiveType -> "I"
        Double::class.javaPrimitiveType -> "D"
        Float::class.javaPrimitiveType -> "F"
        else -> "L${cls.name.replace('.', '/')};"
    }

    private fun returnClassToJni(cls: Class<*>): String = when (cls) {
        Void.TYPE -> "V"
        Boolean::class.javaPrimitiveType -> "Z"
        Int::class.javaPrimitiveType -> "I"
        Double::class.javaPrimitiveType -> "D"
        Float::class.javaPrimitiveType -> "F"
        else -> "L${cls.name.replace('.', '/')};"
    }

    private fun resolveReturnKind(paramTypes: Array<Class<*>>, returnType: Class<*>): Int {
        // Promise as last param → PromiseKind
        if (paramTypes.isNotEmpty() && paramTypes.last() == Promise::class.java) return PROMISE

        return when (returnType) {
            Void.TYPE -> VOID
            Boolean::class.javaPrimitiveType, Boolean::class.javaObjectType -> BOOLEAN
            Double::class.javaPrimitiveType, Double::class.javaObjectType,
            Float::class.javaPrimitiveType, Float::class.javaObjectType,
            Int::class.javaPrimitiveType, Int::class.javaObjectType -> NUMBER
            String::class.java -> STRING
            WritableMap::class.java, MutableMap::class.java -> OBJECT
            WritableArray::class.java -> ARRAY
            else -> OBJECT
        }
    }
}
