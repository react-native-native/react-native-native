use nativ_core::prelude::*;

#[component]
pub struct GpuTriangle;

impl NativeView for GpuTriangle {
    fn mount(&mut self, view: NativeViewHandle) {
        if !view.has_size() {
            return;
        }

        // Just test: set background color directly — no wgpu, no threads
        // Red = layer created, Green = would be wgpu
        view.set_background_color(0.1, 0.8, 0.2, 1.0);
        view.add_label("GPU placeholder (wgpu needs async mount)", 1.0, 1.0, 1.0);
    }
}
