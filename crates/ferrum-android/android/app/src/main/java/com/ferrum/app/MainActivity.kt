package com.ferrum.app

import android.app.Activity
import android.content.res.AssetManager
import android.os.Bundle
import android.widget.TextView

/**
 * Minimal Activity for Project Ferrum Phase 0.
 *
 * This Activity's sole responsibility is:
 * 1. Load the Rust native library (`libferrum_android.so`).
 * 2. Call [initFerrum] to hand the AssetManager to Rust.
 * 3. Display the result string returned by Rust in a TextView.
 *
 * No React Native, no Fabric, no View hierarchy beyond a single TextView.
 * The interesting work happens entirely in Rust.
 *
 * ## Why a thin Java Activity instead of NativeActivity?
 *
 * See NOTES.md §1 for the full trade-off analysis. Short answer: a thin Java
 * Activity is easier to integrate into a standard Android project, works with
 * all API levels, and does not require the `android:hasCode="false"` manifest
 * restriction. NativeActivity is revisited in Phase 1.
 */
class MainActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Display a loading message while Rust initializes.
        val textView = TextView(this).apply {
            text = "Ferrum initializing…"
            textSize = 18f
            setPadding(32, 32, 32, 32)
        }
        setContentView(textView)

        // Initialize the Ferrum runtime synchronously on the main thread.
        // initFerrum() returns a result string for diagnostic display.
        //
        // In Phase 1, this will kick off a Choreographer frame loop and the
        // call will return before the first frame fires. For Phase 0, the
        // synchronous return value is sufficient.
        val result = initFerrum(assets)
        textView.text = result
    }

    // -------------------------------------------------------------------------
    // Native declarations
    // -------------------------------------------------------------------------

    /**
     * Bootstraps the Ferrum runtime.
     *
     * Implemented in Rust at:
     *   `crates/ferrum-android/src/lib.rs`
     *   `Java_com_ferrum_app_MainActivity_initFerrum`
     *
     * @param assetManager the Activity's AssetManager; used by Rust to read
     *                     `assets/bundle.js` (or `assets/bundle.hbc` for bytecode).
     * @return A human-readable result string, e.g. "Ferrum OK: stub eval → rust_add(1, 2) = 3"
     */
    external fun initFerrum(assetManager: AssetManager): String

    companion object {
        init {
            // Load the Rust shared library. The name must match the `[lib] name`
            // in Cargo.toml (default: crate name with hyphens replaced by underscores).
            System.loadLibrary("ferrum_android")
        }
    }
}
