package com.nativfabric

import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.ViewManagerDelegate
import com.facebook.react.uimanager.annotations.ReactProp
import com.facebook.react.viewmanagers.FerrumContainerManagerInterface
import com.facebook.react.viewmanagers.FerrumContainerManagerDelegate

@ReactModule(name = FerrumContainerViewManager.NAME)
class FerrumContainerViewManager : SimpleViewManager<FerrumContainerView>(),
    FerrumContainerManagerInterface<FerrumContainerView> {

    private val delegate: ViewManagerDelegate<FerrumContainerView> =
        FerrumContainerManagerDelegate(this)

    override fun getDelegate(): ViewManagerDelegate<FerrumContainerView> = delegate

    override fun getName(): String = NAME

    override fun createViewInstance(context: ThemedReactContext): FerrumContainerView {
        val view = FerrumContainerView(context)
        view.addOnLayoutChangeListener { _, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom ->
            val w = right - left
            val h = bottom - top
            val oldW = oldRight - oldLeft
            val oldH = oldBottom - oldTop
            if (w != oldW || h != oldH) {
                renderComponent(view)
            }
        }
        return view
    }

    @ReactProp(name = "componentId")
    override fun setComponentId(view: FerrumContainerView?, value: String?) {
        view?.tag = value
        view?.let { renderComponent(it) }
    }

    @ReactProp(name = "propsJson")
    override fun setPropsJson(view: FerrumContainerView?, value: String?) {
        view?.let { renderComponent(it) }
    }

    private fun renderComponent(view: FerrumContainerView) {
        val componentId = view.tag as? String ?: return
        if (view.width <= 0 || view.height <= 0) {
            view.post { renderComponent(view) }
            return
        }

        // Render directly into the view
        view.removeAllViews()
        FerrumRuntime.tryRender(componentId, view, view.width.toFloat(), view.height.toFloat())
    }

    companion object {
        const val NAME = "FerrumContainer"
    }
}
