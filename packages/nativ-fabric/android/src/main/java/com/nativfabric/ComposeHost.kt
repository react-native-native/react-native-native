package com.nativfabric

import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.ComposeView

/**
 * ComposeHost — APK-side helper for .dex Compose components.
 *
 * The .dex can't call ComposeView.setContent directly (signature mismatch
 * between compile-time and runtime due to Compose compiler transforms).
 * This helper is compiled WITH the Gradle Compose plugin, so setContent works.
 * The .dex calls ComposeHost.render(parent) { MyComposable(props) } instead.
 */
object ComposeHost {
    @JvmStatic
    fun render(parent: ViewGroup, content: @Composable () -> Unit) {
        val composeView = ComposeView(parent.context)
        composeView.setContent(content)
        parent.addView(composeView, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        ))
    }
}
