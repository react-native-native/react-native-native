//! `rna-macros` — proc macros for react-native-anywhere.

use proc_macro::TokenStream;
use quote::{quote, format_ident};
use syn::{parse_macro_input, ItemStruct, ItemFn, Fields};

/// Marks a struct as a react-native-anywhere component.
///
/// Struct fields become JS props, automatically extracted via JSI:
/// - `String` → `props.get_string("field_name")`
/// - `f64` / `f32` → `props.get_number("field_name")`
/// - `bool` → `props.get_bool("field_name")`
/// - `Callback` → `props.get_callback("field_name")`
///
/// Unit structs (no fields) receive no props.
///
/// ```rust
/// use nativ_core::prelude::*;
///
/// #[component]
/// pub struct MyButton {
///     text: String,
///     font_size: f64,
///     on_press: Callback,
/// }
///
/// impl NativeView for MyButton {
///     fn mount(&mut self, view: NativeViewHandle) {
///         view.add_label(&self.text, 1.0, 1.0, 1.0);
///         self.on_press.invoke();
///     }
/// }
/// ```
#[proc_macro_attribute]
pub fn component(_attr: TokenStream, item: TokenStream) -> TokenStream {
    let input = parse_macro_input!(item as ItemStruct);
    let struct_name = &input.ident;
    let component_id = format!("nativ.{}", struct_name.to_string().to_lowercase());
    let render_fn_name = format_ident!("nativ_{}_render", struct_name.to_string().to_lowercase());
    let register_fn_name = format_ident!("_nativ_register_{}", struct_name.to_string().to_lowercase());
    let register_static = format_ident!("_NATIV_REGISTER_{}", struct_name.to_string().to_uppercase());

    // Generate prop extraction code from struct fields
    let construct_expr = match &input.fields {
        Fields::Named(fields) => {
            let field_inits: Vec<_> = fields.named.iter().map(|f| {
                let field_name = f.ident.as_ref().unwrap();
                let field_name_str = field_name.to_string();
                let ty = &f.ty;

                // Convert snake_case to camelCase for JS prop name
                let js_name = to_camel_case(&field_name_str);

                // Match on the type to determine which getter to use
                let ty_str = quote!(#ty).to_string().replace(' ', "");
                match ty_str.as_str() {
                    "String" => quote! {
                        #field_name: _props.as_ref()
                            .map(|p| p.get_string(#js_name))
                            .unwrap_or_default()
                    },
                    "f64" => quote! {
                        #field_name: _props.as_ref()
                            .map(|p| p.get_number(#js_name))
                            .unwrap_or(0.0)
                    },
                    "f32" => quote! {
                        #field_name: _props.as_ref()
                            .map(|p| p.get_number(#js_name) as f32)
                            .unwrap_or(0.0)
                    },
                    "bool" => quote! {
                        #field_name: _props.as_ref()
                            .map(|p| p.get_bool(#js_name))
                            .unwrap_or(false)
                    },
                    "Callback" | "nativ_core::props::Callback" => quote! {
                        #field_name: _props.as_ref()
                            .map(|p| p.get_callback(#js_name))
                            .unwrap_or_else(|| nativ_core::props::Callback::noop())
                    },
                    _ => quote! {
                        #field_name: Default::default()
                    },
                }
            }).collect();

            quote! {
                #struct_name {
                    #(#field_inits),*
                }
            }
        }
        Fields::Unit => {
            // Unit struct — no props
            quote! { #struct_name }
        }
        _ => {
            quote! { #struct_name {} }
        }
    };

    let expanded = quote! {
        #input

        #[unsafe(no_mangle)]
        pub unsafe extern "C" fn #render_fn_name(
            view: *mut ::std::ffi::c_void,
            width: ::std::ffi::c_float,
            height: ::std::ffi::c_float,
            jsi_runtime: *mut ::std::ffi::c_void,
            jsi_props: *mut ::std::ffi::c_void,
        ) {
            let handle = nativ_core::NativeViewHandle::new(view, width as f32, height as f32);
            let _props = nativ_core::props::Props::new(jsi_runtime, jsi_props);
            let mut component = #construct_expr;
            <#struct_name as nativ_core::NativeView>::mount(&mut component, handle);
        }

        // iOS: auto-register via constructor
        #[cfg(target_os = "ios")]
        #[used]
        #[unsafe(link_section = "__DATA,__mod_init_func")]
        static #register_static: extern "C" fn() = {
            extern "C" fn #register_fn_name() {
                let id = ::std::ffi::CString::new(#component_id).unwrap();
                unsafe {
                    nativ_core::ffi::nativ_register_render(
                        id.as_ptr(),
                        #render_fn_name,
                    );
                }
            }
            #register_fn_name
        };

        // Android dev: host calls nativ_init_render after dlopen with the registry fn pointer.
        // Skipped in unified crate (production) — uses constructor instead.
        #[cfg(all(target_os = "android", not(unified)))]
        #[unsafe(no_mangle)]
        pub unsafe extern "C" fn nativ_init_render(reg_fn: *mut ::std::ffi::c_void) {
            type RegFn = unsafe extern "C" fn(*const ::std::ffi::c_char, unsafe extern "C" fn(*mut ::std::ffi::c_void, ::std::ffi::c_float, ::std::ffi::c_float, *mut ::std::ffi::c_void, *mut ::std::ffi::c_void));
            let reg: RegFn = unsafe { ::std::mem::transmute(reg_fn) };
            let id = ::std::ffi::CString::new(#component_id).unwrap();
            unsafe { reg(id.as_ptr(), #render_fn_name); }
        }

        // Android production (unified crate): register via constructor.
        // .init_array fires when JVM loads the .so via System.loadLibrary().
        #[cfg(all(target_os = "android", unified))]
        #[used]
        #[unsafe(link_section = ".init_array")]
        static #register_static: extern "C" fn() = {
            extern "C" fn #register_fn_name() {
                let id = ::std::ffi::CString::new(#component_id).unwrap();
                unsafe {
                    nativ_core::ffi::nativ_register_render(
                        id.as_ptr(),
                        #render_fn_name,
                    );
                }
            }
            #register_fn_name
        };
    };

    TokenStream::from(expanded)
}

/// Convert snake_case to camelCase for JS prop names.
/// e.g., "font_size" → "fontSize", "on_press" → "onPress"
fn to_camel_case(s: &str) -> String {
    let mut result = String::new();
    let mut capitalize_next = false;
    for c in s.chars() {
        if c == '_' {
            capitalize_next = true;
        } else if capitalize_next {
            result.push(c.to_ascii_uppercase());
            capitalize_next = false;
        } else {
            result.push(c);
        }
    }
    result
}

/// Marks a function for export to JavaScript (placeholder — extraction done by JS compiler).
#[proc_macro_attribute]
pub fn function(_attr: TokenStream, item: TokenStream) -> TokenStream {
    let input = parse_macro_input!(item as ItemFn);
    let expanded = quote! { #input };
    TokenStream::from(expanded)
}
