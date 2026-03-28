package com.ferrum.app

import android.view.Choreographer

/**
 * Choreographer frame callback bridge for Project Ferrum.
 *
 * This class bridges Android's [Choreographer.FrameCallback] to Rust by
 * calling the `onFrame` JNI method on each vsync. It re-registers itself
 * after each frame to create a continuous frame loop.
 *
 * ## Threading
 *
 * [Choreographer.postFrameCallback] must be called from a thread that has
 * a [android.os.Looper] attached. [doFrame] is always delivered on the same
 * thread that called [start], which for Ferrum is the main thread.
 *
 * Rust's `onFrame` JNI handler therefore runs on the main thread. Any Hermes
 * or Fabric work triggered from `onFrame` is main-thread-safe.
 *
 * ## Phase 0 vs Phase 1
 *
 * Phase 0: [onFrame] increments a Rust counter and logs once per second.
 * Phase 1: [onFrame] drives `ferrum_core::tick(frameTimeNanos)`, which
 *          runs Hermes `requestAnimationFrame` callbacks and commits Fabric
 *          shadow tree mutations to the main thread view hierarchy.
 *
 * ## Usage
 *
 * ```kotlin
 * // Called from MainActivity after initFerrum() returns:
 * FerrumFrameCallback.start()
 * ```
 */
class FerrumFrameCallback : Choreographer.FrameCallback {

    override fun doFrame(frameTimeNanos: Long) {
        // Forward the vsync timestamp to Rust.
        onFrame(frameTimeNanos)

        // Re-register to keep the loop alive. Choreographer callbacks are
        // one-shot; they must be re-posted each frame.
        Choreographer.getInstance().postFrameCallback(this)
    }

    companion object {
        private var instance: FerrumFrameCallback? = null

        /**
         * Starts the frame loop. Must be called from the main thread.
         * Idempotent: calling multiple times has no effect.
         */
        fun start() {
            if (instance == null) {
                instance = FerrumFrameCallback()
                Choreographer.getInstance().postFrameCallback(instance)
            }
        }

        /**
         * Stops the frame loop. The current in-flight callback may still
         * fire once after this call.
         */
        fun stop() {
            instance?.let { Choreographer.getInstance().removeFrameCallback(it) }
            instance = null
        }
    }

    // -------------------------------------------------------------------------
    // JNI declaration
    // -------------------------------------------------------------------------

    /**
     * Called from Rust on each vsync frame.
     *
     * Implemented at:
     *   `crates/ferrum-android/src/lib.rs`
     *   `Java_com_ferrum_app_FerrumFrameCallback_onFrame`
     *
     * @param frameTimeNanos vsync timestamp in nanoseconds (from Choreographer)
     */
    private external fun onFrame(frameTimeNanos: Long)
}
