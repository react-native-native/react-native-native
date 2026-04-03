package com.nativfabric

import android.content.Context
import android.view.View
import android.widget.FrameLayout

/**
 * NativContainerView — hosts native views rendered by Rust/C++/Kotlin/Compose.
 *
 * Simple FrameLayout. Render functions add children directly.
 * We override onLayout to manually measure/layout children since
 * Fabric/Yoga doesn't measure programmatically-added Android views.
 */
class NativContainerView(context: Context) : FrameLayout(context) {
    init {
        setBackgroundColor(0x00000000)
    }

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
        super.onLayout(changed, left, top, right, bottom)
        // Manually measure+layout all children since Fabric doesn't know about them
        val w = right - left
        val h = bottom - top
        if (w <= 0 || h <= 0) return
        val wSpec = MeasureSpec.makeMeasureSpec(w, MeasureSpec.EXACTLY)
        val hSpec = MeasureSpec.makeMeasureSpec(h, MeasureSpec.EXACTLY)
        for (i in 0 until childCount) {
            val child = getChildAt(i)
            child.measure(wSpec, hSpec)
            child.layout(0, 0, w, h)
        }
    }

    override fun requestLayout() {
        super.requestLayout()
        // Fabric intercepts requestLayout — force a measure pass
        post {
            val w = width
            val h = height
            if (w > 0 && h > 0) {
                val wSpec = MeasureSpec.makeMeasureSpec(w, MeasureSpec.EXACTLY)
                val hSpec = MeasureSpec.makeMeasureSpec(h, MeasureSpec.EXACTLY)
                for (i in 0 until childCount) {
                    val child = getChildAt(i)
                    child.measure(wSpec, hSpec)
                    child.layout(0, 0, w, h)
                }
            }
        }
    }
}
