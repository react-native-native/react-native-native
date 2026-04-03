// kotlin_utils.kt — Kotlin functions exported to JavaScript
//
// Same pattern as math_utils.cpp / rust_math.rs but in Kotlin.
// Edit and save — hot-reloads on device.

// @nativ_export(sync)
fun factorial(n: Int): Long {
    var result = 1L
    for (i in 2..n) result *= i
    return result
}

// @nativ_export(sync)
fun isPalindrome(text: String): Boolean {
    val clean = text.lowercase().filter { it.isLetterOrDigit() }
    return clean == clean.reversed()
}

// @nativ_export(sync)
fun greetKotlin(name: String): String {
    return "Hi $name, from Kotlin!"
}
