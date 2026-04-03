// KotlinCounter.kt — Kotlin component using Android Views (no Compose)
//
// Same DX as C++/Rust components — create views, add to parent.
// Edit and save — hot-reloads on device via .dex.

import android.graphics.Color
import android.graphics.Typeface
import android.view.Gravity
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView

// @nativ_component
fun KotlinCounter(parent: ViewGroup, props: Map<String, Any?>) {
    val context = parent.context
    val title = props["title"] as? String ?: "Kotlin Counter"
    val bgColor = when (props["color"] as? String) {
        "blue" -> Color.parseColor("#1565C0")
        "green" -> Color.parseColor("#2E7D32")
        "purple" -> Color.parseColor("#6A1B9A")
        else -> Color.parseColor("#E91E63")
    }

    // Root container
    val root = LinearLayout(context).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        setBackgroundColor(bgColor)
        setPadding(48, 32, 48, 32)
    }

    // Title + subtitle column
    val textCol = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
    }

    textCol.addView(TextView(context).apply {
        text = title
        setTextColor(Color.WHITE)
        textSize = 16f
        typeface = Typeface.DEFAULT_BOLD
    })

    textCol.addView(TextView(context).apply {
        text = "From Kotlin!"
        setTextColor(Color.argb(200, 255, 255, 255))
        textSize = 19f
    })

    root.addView(textCol)

    // Badge
    root.addView(TextView(context).apply {
        text = "KT"
        setTextColor(Color.WHITE)
        textSize = 18f
        typeface = Typeface.DEFAULT_BOLD
        gravity = Gravity.CENTER
        setBackgroundColor(Color.argb(5, 255, 255, 255))
        setPadding(24, 12, 24, 12)
    })

    parent.addView(root, FrameLayout.LayoutParams(
        FrameLayout.LayoutParams.MATCH_PARENT,
        FrameLayout.LayoutParams.MATCH_PARENT
    ))
}
