use nativ_core::prelude::*;

#[component]
pub struct HelloRust {
    text: String,
    r: f64,
    g: f64,
    b: f64,
    on_press: Callback,
}

impl NativeView for HelloRust {
    fn mount(&mut self, view: NativeViewHandle) {
        let text = if self.text.is_empty() { "Hello from Rust!" } else { &self.text };
        let r = if self.r == 0.0 && self.g == 0.0 && self.b == 0.0 { 0.91 } else { self.r };
        let g = if self.r == 0.0 && self.g == 0.0 && self.b == 0.0 { 0.27 } else { self.g };
        let b = if self.r == 0.0 && self.g == 0.0 && self.b == 0.0 { 0.38 } else { self.b };

        view.set_background_color(r, g, b, 1.0);
        view.add_label(text, 0.85, 1.0, 0.0);

        if self.on_press.is_set() {
            self.on_press.invoke();
        }
    }
}

