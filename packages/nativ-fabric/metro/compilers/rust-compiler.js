/**
 * Compiles a .rs file to a signed arm64 iOS cdylib.
 *
 * Handles two modes:
 *   - Component: file has `pub fn render(view, w, h)` → registers via nativ_register_render
 *   - Functions: file has `#[function]` annotations → registers via nativ_register_sync
 */

const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const { extractRustExports } = require("../extractors/rust-extractor");

let _signingIdentity = null;
let _resolved = false;

function resolveOnce(projectRoot) {
  if (_resolved) return;
  _resolved = true;

  try {
    let appTeamId = null;
    try {
      const appJson = JSON.parse(
        fs.readFileSync(path.join(projectRoot, "app.json"), "utf8"),
      );
      appTeamId = appJson?.expo?.ios?.appleTeamId || null;
    } catch {}

    if (!appTeamId) {
      try {
        const pbx = execSync(
          `find "${projectRoot}/ios" -name "project.pbxproj" -maxdepth 3 2>/dev/null`,
          { encoding: "utf8" },
        )
          .trim()
          .split("\n")[0];
        if (pbx) {
          const m = fs
            .readFileSync(pbx, "utf8")
            .match(/DEVELOPMENT_TEAM\s*=\s*(\w+)/);
          if (m) appTeamId = m[1];
        }
      } catch {}
    }

    if (appTeamId) {
      const identities = execSync("security find-identity -v -p codesigning", {
        encoding: "utf8",
      });
      const entries = [...identities.matchAll(/([A-F0-9]{40})\s+"([^"]+)"/g)];
      for (const [, , name] of entries) {
        try {
          const subject = execSync(
            `security find-certificate -c "${name}" -p 2>/dev/null | openssl x509 -noout -subject 2>/dev/null`,
            { encoding: "utf8" },
          );
          if (subject.includes(`OU=${appTeamId}`)) {
            _signingIdentity = name;
            break;
          }
        } catch {}
      }
    }
  } catch {}
}

let _nativeDylibBuilt = false;

/**
 * Build the root `native` crate as a shared dylib containing all deps.
 * Runs once per Metro session. Cargo fingerprinting handles Cargo.toml changes.
 */
function ensureNativeDylib(projectRoot) {
  if (_nativeDylibBuilt) return;
  _nativeDylibBuilt = true;

  const sharedTarget = path.join(projectRoot, ".nativ/cargo-target");
  const outputDir = path.join(projectRoot, ".nativ/dylibs");
  fs.mkdirSync(outputDir, { recursive: true });

  console.log("[nativ] Building native.dylib (shared deps)...");
  try {
    execSync(
      [
        "cargo",
        "build",
        "--manifest-path",
        path.join(projectRoot, "Cargo.toml"),
        "--target=aarch64-apple-ios",
        "--lib",
      ].join(" "),
      {
        stdio: "pipe",
        encoding: "utf8",
        env: {
          ...process.env,
          RUSTFLAGS: "-C link-arg=-undefined -C link-arg=dynamic_lookup",
          CARGO_TARGET_DIR: sharedTarget,
        },
      },
    );

    // Copy to dylibs dir
    const built = path.join(
      sharedTarget,
      "aarch64-apple-ios/debug/libnative.dylib",
    );
    if (fs.existsSync(built)) {
      fs.copyFileSync(built, path.join(outputDir, "native.dylib"));

      // Sign
      resolveOnce(projectRoot);
      if (_signingIdentity) {
        try {
          execSync(
            `codesign -fs "${_signingIdentity}" "${path.join(outputDir, "native.dylib")}"`,
            { stdio: "pipe" },
          );
        } catch {}
      }

      const size = fs.statSync(path.join(outputDir, "native.dylib")).size;
      console.log(
        `[nativ] Built native.dylib (${(size / 1024).toFixed(1)}KB) — shared deps`,
      );
    }
  } catch (err) {
    console.error(
      "[nativ] native.dylib build failed:",
      (err.stderr || "").slice(0, 1000),
    );
  }
}

/**
 * Ensure the per-file Cargo crate exists and src/lib.rs is up to date.
 * Shared between iOS and Android compilers.
 * Returns { crateDir, moduleId, isComponent, functions } or null if no exports.
 */
function ensureRustCrate(filepath, projectRoot) {
  const name = path.basename(filepath, ".rs");
  const moduleId = name.toLowerCase();

  const userSrc = fs.readFileSync(filepath, "utf8");
  const { functions, isComponent } = extractRustExports(filepath);

  if (!isComponent && functions.length === 0) {
    console.warn(
      `[nativ] ${name}.rs: no #[component] or #[function] found, skipping`,
    );
    return null;
  }

  // The user's Cargo.toml must exist — created by `npx @react-native-native/cli setup-rust`
  const cargoTomlPath = path.join(projectRoot, "Cargo.toml");
  if (!fs.existsSync(cargoTomlPath)) {
    console.error(
      "[nativ] No Cargo.toml found. Run: npx @react-native-native/cli setup-rust",
    );
    return null;
  }

  // Per-file build crate
  const crateDir = path.join(projectRoot, ".nativ/build", moduleId);
  fs.mkdirSync(path.join(crateDir, "src"), { recursive: true });

  const buildCargoPath = path.join(crateDir, "Cargo.toml");

  // Forward ALL deps from root Cargo.toml (including target-specific)
  let rootDeps = "";
  let targetDeps = "";
  try {
    const rootToml = fs.readFileSync(
      path.join(projectRoot, "Cargo.toml"),
      "utf8",
    );

    // [dependencies] section
    const depsSection = rootToml.match(
      /\[dependencies\]([\s\S]*?)(?:\n\[|\n*$)/,
    );
    if (depsSection) {
      rootDeps = depsSection[1].replace(/path\s*=\s*"([^"]+)"/g, (_, p) => {
        const absPath = path.resolve(projectRoot, p);
        const relPath = path.relative(crateDir, absPath);
        return `path = "${relPath}"`;
      });
    }

    // [target.'cfg(...)'.dependencies] sections — forward as-is with path rewriting
    const targetSections = rootToml.matchAll(
      /(\[target\.[^\]]+\.dependencies\])([\s\S]*?)(?=\n\[|\n*$)/g,
    );
    for (const m of targetSections) {
      const header = m[1];
      const deps = m[2].replace(/path\s*=\s*"([^"]+)"/g, (_, p) => {
        const absPath = path.resolve(projectRoot, p);
        const relPath = path.relative(crateDir, absPath);
        return `path = "${relPath}"`;
      });
      targetDeps += `\n${header}${deps}\n`;
    }
  } catch {}

  const buildCargo = `[package]
name = "ferrum-${moduleId}"
version = "0.1.0"
edition = "2024"

[lib]
crate-type = ["cdylib"]

[workspace]

[dependencies]
${rootDeps}
${targetDeps}
[profile.dev]
opt-level = 1
`;
  fs.writeFileSync(buildCargoPath, buildCargo);

  // Write src/lib.rs
  let libSrc;
  if (isComponent) {
    libSrc = userSrc;
  } else {
    libSrc = generateFunctionWrapper(userSrc, functions, moduleId);
  }
  const libPath = path.join(crateDir, "src/lib.rs");
  fs.writeFileSync(libPath, libSrc);

  return { crateDir, moduleId, isComponent, functions };
}

function compileRustDylib(filepath, projectRoot, { target = "device" } = {}) {
  resolveOnce(projectRoot);

  const crate = ensureRustCrate(filepath, projectRoot);
  if (!crate) return null;

  const { crateDir, moduleId, isComponent, functions } = crate;
  const rustTarget =
    target === "simulator" ? "aarch64-apple-ios-sim" : "aarch64-apple-ios";
  const outputDir = path.join(projectRoot, ".nativ/dylibs", target);
  fs.mkdirSync(outputDir, { recursive: true });
  const dylibPath = path.join(outputDir, `nativ_${moduleId}.dylib`);

  const sharedTarget = path.join(projectRoot, ".nativ/cargo-target");
  const cargoOutDir = path.join(sharedTarget, `${rustTarget}/debug`);

  const name = path.basename(filepath, ".rs");

  // Force rebuild: remove the old dylib so Cargo can't skip
  const oldDylib = path.join(cargoOutDir, `libnativ_${moduleId}.dylib`);
  try {
    fs.unlinkSync(oldDylib);
  } catch {}

  const cmd = [
    "cargo",
    "build",
    "--manifest-path",
    path.join(crateDir, "Cargo.toml"),
    `--target=${rustTarget}`,
    "--lib",
  ];

  const rustFlags = "-C link-arg=-undefined -C link-arg=dynamic_lookup";

  console.log(`[nativ] Compiling ${name}.rs via cargo...`);
  try {
    const output = execSync(cmd.join(" "), {
      stdio: "pipe",
      encoding: "utf8",
      env: {
        ...process.env,
        RUSTFLAGS: rustFlags,
        CARGO_TARGET_DIR: sharedTarget,
      },
    });
    if (output) console.log(output.trim());
  } catch (err) {
    console.error(`[nativ] Rust compile failed: ${name}.rs`);
    console.error((err.stderr || "").slice(0, 5000));
    return null;
  }

  // Copy the built dylib from Cargo's target dir to our dylib output dir
  const builtDylib = path.join(cargoOutDir, `libnativ_${moduleId}.dylib`);
  if (!fs.existsSync(builtDylib)) {
    console.error(`[nativ] Built dylib not found: ${builtDylib}`);
    return null;
  }
  fs.copyFileSync(builtDylib, dylibPath);

  if (_signingIdentity) {
    try {
      execSync(`codesign -fs "${_signingIdentity}" "${dylibPath}"`, {
        stdio: "pipe",
      });
    } catch {}
  }

  const size = fs.statSync(dylibPath).size;
  console.log(
    `[nativ] Built nativ_${moduleId}.dylib (${(size / 1024).toFixed(1)}KB)`,
  );
  return { dylibPath, isComponent, functions };
}

// ─── Component wrapper ─────────────────────────────────────────────────

function generateComponentWrapper(userSrc, moduleId, { unified = false } = {}) {
  const componentId = `ferrum.${moduleId}`;

  // In unified mode, nativ-core is available via the crate root.
  // The #[component] proc macro handles render function generation,
  // prop extraction, and registration. Just pass through user source.
  if (unified) {
    return `#![allow(unused, non_snake_case, unused_unsafe)]
use crate::*;

${userSrc}
`;
  }

  // ── Standalone mode (dev hot-reload) ─────────────────────────────────
  // nativ-core can't be linked into a hot-reload dylib, so all types
  // are defined inline and #[component] is stripped.

  // Extract struct name from #[component] pub struct Foo;
  const structMatch = userSrc.match(/#\[component\]\s*pub\s+struct\s+(\w+)/);
  const structName = structMatch ? structMatch[1] : "Component";

  // Strip #[component] attribute — it's not real Rust
  const cleanSrc = userSrc.replace(/#\[component\]\s*/g, "");

  const typeImports = `use nativ_core::prelude::*;`;

  const inlineTypes = `
// ─── ObjC runtime FFI ──────────────────────────────────────────────────
#[link(name = "objc", kind = "dylib")]
unsafe extern "C" {
    fn objc_getClass(name: *const c_char) -> *mut c_void;
    fn sel_registerName(name: *const c_char) -> *mut c_void;
    fn objc_msgSend() -> *mut c_void;
}

type MsgSendPtr = unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void;
type MsgSendVoidPtr = unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void);

fn _class(name: &str) -> *mut c_void {
    let c = CString::new(name).unwrap();
    unsafe { objc_getClass(c.as_ptr()) }
}
fn _sel(name: &str) -> *mut c_void {
    let c = CString::new(name).unwrap();
    unsafe { sel_registerName(c.as_ptr()) }
}
fn _new(cls: &str) -> *mut c_void {
    let alloc: MsgSendPtr = unsafe { std::mem::transmute(objc_msgSend as *mut c_void) };
    let init: MsgSendPtr = unsafe { std::mem::transmute(objc_msgSend as *mut c_void) };
    unsafe { init(alloc(_class(cls), _sel("alloc")), _sel("init")) }
}
fn _nsstring(s: &str) -> *mut c_void {
    let cstr = CString::new(s).unwrap();
    let send: unsafe extern "C" fn(*mut c_void, *mut c_void, *const c_char) -> *mut c_void =
        unsafe { std::mem::transmute(objc_msgSend as *mut c_void) };
    unsafe { send(_class("NSString"), _sel("stringWithUTF8String:"), cstr.as_ptr()) }
}
fn _uicolor(r: f64, g: f64, b: f64, a: f64) -> *mut c_void {
    let send: unsafe extern "C" fn(*mut c_void, *mut c_void, f64, f64, f64, f64) -> *mut c_void =
        unsafe { std::mem::transmute(objc_msgSend as *mut c_void) };
    unsafe { send(_class("UIColor"), _sel("colorWithRed:green:blue:alpha:"), r, g, b, a) }
}

pub struct NativeViewHandle {
    view: *mut c_void,
    width: f32,
    height: f32,
}

impl NativeViewHandle {
    fn new(view: *mut c_void, width: f32, height: f32) -> Self {
        Self { view, width, height }
    }

    pub fn set_background_color(&self, r: f64, g: f64, b: f64, a: f64) {
        let color = _uicolor(r, g, b, a);
        let send: MsgSendVoidPtr = unsafe { std::mem::transmute(objc_msgSend as *mut c_void) };
        unsafe { send(self.view, _sel("setBackgroundColor:"), color); }
    }

    pub fn add_label(&self, text: &str, r: f64, g: f64, b: f64) {
        let label = _new("UILabel");
        let w = self.width as f64;
        let h = self.height as f64;

        let set_text: MsgSendVoidPtr = unsafe { std::mem::transmute(objc_msgSend as *mut c_void) };
        unsafe { set_text(label, _sel("setText:"), _nsstring(text)); }

        let color = _uicolor(r, g, b, 1.0);
        unsafe { set_text(label, _sel("setTextColor:"), color); }

        let set_align: unsafe extern "C" fn(*mut c_void, *mut c_void, i64) =
            unsafe { std::mem::transmute(objc_msgSend as *mut c_void) };
        unsafe { set_align(label, _sel("setTextAlignment:"), 1); }

        let set_frame: unsafe extern "C" fn(*mut c_void, *mut c_void, f64, f64, f64, f64) =
            unsafe { std::mem::transmute(objc_msgSend as *mut c_void) };
        unsafe { set_frame(label, _sel("setFrame:"), 0.0, 0.0, w, h); }

        let add_sub: MsgSendVoidPtr = unsafe { std::mem::transmute(objc_msgSend as *mut c_void) };
        unsafe { add_sub(self.view, _sel("addSubview:"), label); }
    }
}

pub trait NativeView {
    fn mount(&mut self, view: NativeViewHandle);
}
`;

  return `
#![allow(unused, non_snake_case, unused_unsafe)]
use std::ffi::{c_void, c_char, c_float, CString};
${typeImports}
${inlineTypes}
// ─── User code ─────────────────────────────────────────────────────────
${cleanSrc}

// ─── Registration ──────────────────────────────────────────────────────
unsafe extern "C" {
    fn nativ_register_render(id: *const c_char, f: unsafe extern "C" fn(*mut c_void, c_float, c_float));
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn nativ_${moduleId}_render(view: *mut c_void, w: c_float, h: c_float) {
    let handle = NativeViewHandle::new(view, w as f32, h as f32);
    let mut component = ${structName};
    component.mount(handle);
}

#[used]
#[cfg_attr(target_os = "ios", unsafe(link_section = "__DATA,__mod_init_func"))]
static REGISTER: extern "C" fn() = {
    extern "C" fn register() {
        let id = CString::new("${componentId}").unwrap();
        unsafe { nativ_register_render(id.as_ptr(), nativ_${moduleId}_render); }
    }
    register
};
`;
}

// ─── Function wrapper ──────────────────────────────────────────────────

function generateFunctionWrapper(
  userSrc,
  functions,
  moduleId,
  { unified = false } = {},
) {
  const argParsers = [];
  const registrations = [];

  const asyncParsers = [];
  const asyncRegistrations = [];

  for (const fn of functions) {
    // Generate a C ABI wrapper that parses JSON args and calls the Rust function
    const argExtractions = fn.args.map((arg, i) => {
      const t = arg.type;
      if (t === "String" || t === "&str") {
        return `    let ${arg.name}: String = _parse_string(&mut p);`;
      } else if (t === "bool") {
        return `    let ${arg.name}: bool = _parse_number(&mut p) != 0.0;`;
      } else {
        return `    let ${arg.name}: ${t} = _parse_number(&mut p) as ${t};`;
      }
    });

    const argNames = fn.args.map((a) => {
      if (a.type === "&str") return `&${a.name}`;
      return a.name;
    });

    const retConvert = (() => {
      const rt = fn.ret;
      if (rt === "()") return "    let _result = ";
      if (rt.startsWith("Result<")) return "    let _result = ";
      return "    let _result = ";
    })();

    const retSerialize = (() => {
      const rt = fn.ret;
      if (rt === "()" || rt === "void") return '"null"';
      if (rt === "String" || rt === "&str") {
        return 'format!("\\\"{}\\\"", _result)'; // JSON string
      }
      if (rt === "bool") return 'if _result { "true" } else { "false" }';
      if (rt.startsWith("Result<")) {
        // Unwrap the Result
        return null; // handled specially below
      }
      return "_result.to_string()"; // numbers
    })();

    const isResult = fn.ret.startsWith("Result<");

    if (fn.async) {
      // Async wrapper: receives resolve/reject C function pointers
      asyncParsers.push(`
#[unsafe(no_mangle)]
pub extern "C" fn nativ_rust_async_${moduleId}_${fn.name}(
    args_json: *const c_char,
    resolve: extern "C" fn(*const c_char),
    reject: extern "C" fn(*const c_char, *const c_char),
) {
    let args_str = unsafe { std::ffi::CStr::from_ptr(args_json).to_str().unwrap_or("[]") };
    let mut p = args_str;
    if let Some(i) = p.find('[') { p = &p[i+1..]; }
${argExtractions.join("\n")}
    let _result = ${fn.name}(${argNames.join(", ")});
    let json = serde_like_serialize(&_result);
    let c = CString::new(json).unwrap();
    resolve(c.as_ptr());
}`);

      asyncRegistrations.push(
        `        nativ_register_async(
            CString::new("nativ.${moduleId}").unwrap().as_ptr(),
            CString::new("${fn.name}").unwrap().as_ptr(),
            nativ_rust_async_${moduleId}_${fn.name},
        );`,
      );
      continue;
    }

    argParsers.push(`
#[unsafe(no_mangle)]
pub extern "C" fn nativ_rust_${moduleId}_${fn.name}(args_json: *const c_char) -> *const c_char {
    let args_str = unsafe { std::ffi::CStr::from_ptr(args_json).to_str().unwrap_or("[]") };
    let mut p = args_str;
    // Skip to first [
    if let Some(i) = p.find('[') { p = &p[i+1..]; }
${argExtractions.join("\n")}
    let _result = ${fn.name}(${argNames.join(", ")});
    ${
      isResult
        ? `
    match _result {
        Ok(v) => {
            let json = format!("{}", serde_like_serialize(&v));
            let c = CString::new(json).unwrap();
            c.into_raw()
        }
        Err(e) => {
            let json = format!("null");
            let c = CString::new(json).unwrap();
            c.into_raw()
        }
    }`
        : `
    let json = serde_like_serialize(&_result);
    let c = CString::new(json).unwrap();
    c.into_raw()`
    }
}`);

    registrations.push(
      `        nativ_register_sync(
            CString::new("nativ.${moduleId}").unwrap().as_ptr(),
            CString::new("${fn.name}").unwrap().as_ptr(),
            nativ_rust_${moduleId}_${fn.name},
        );`,
    );
  }

  return `
#![allow(unused, non_snake_case)]
use std::ffi::{c_void, c_char, CString};

// Minimal JSON arg parsing
fn _parse_number(p: &mut &str) -> f64 {
    // Skip whitespace and commas
    *p = p.trim_start_matches(|c: char| c == ' ' || c == ',' || c == '[' || c == ']');
    if p.is_empty() { return 0.0; }
    let end = p.find(|c: char| c == ',' || c == ']' || c == ' ').unwrap_or(p.len());
    let num_str = &p[..end];
    *p = &p[end..];
    num_str.parse::<f64>().unwrap_or(0.0)
}

fn _parse_string(p: &mut &str) -> String {
    // Skip to opening quote
    if let Some(i) = p.find('"') {
        *p = &p[i+1..];
    }
    let mut s = String::new();
    let bytes = p.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'"' { *p = &p[i+1..]; return s; }
        if bytes[i] == b'\\\\' && i + 1 < bytes.len() {
            i += 1;
            s.push(bytes[i] as char);
        } else {
            s.push(bytes[i] as char);
        }
        i += 1;
    }
    s
}

// Simple serialization
trait SerializeLike { fn serialize(&self) -> String; }
impl SerializeLike for i32 { fn serialize(&self) -> String { self.to_string() } }
impl SerializeLike for i64 { fn serialize(&self) -> String { self.to_string() } }
impl SerializeLike for u32 { fn serialize(&self) -> String { self.to_string() } }
impl SerializeLike for f32 { fn serialize(&self) -> String { self.to_string() } }
impl SerializeLike for f64 { fn serialize(&self) -> String { self.to_string() } }
impl SerializeLike for bool { fn serialize(&self) -> String { if *self { "true".into() } else { "false".into() } } }
impl SerializeLike for String { fn serialize(&self) -> String { format!("\\\"{}\\\"", self) } }
impl SerializeLike for () { fn serialize(&self) -> String { "null".into() } }

fn serde_like_serialize<T: SerializeLike>(v: &T) -> String { v.serialize() }

// Registry
type NativSyncFn = extern "C" fn(*const c_char) -> *const c_char;
type NativAsyncFn = extern "C" fn(*const c_char, extern "C" fn(*const c_char), extern "C" fn(*const c_char, *const c_char));

// On iOS: direct extern reference (resolved via -undefined dynamic_lookup)
#[cfg(target_os = "ios")]
unsafe extern "C" {
    fn nativ_register_sync(module_id: *const c_char, fn_name: *const c_char, f: NativSyncFn);
    fn nativ_register_async(module_id: *const c_char, fn_name: *const c_char, f: NativAsyncFn);
}

// ─── User code ─────────────────────────────────────────────────────────
${userSrc.replace(/#\[function[^\]]*\]/g, "")}

// ─── C ABI wrappers ───────────────────────────────────────────────────
${argParsers.join("\n")}
${asyncParsers.join("\n")}

// ─── Registration ──────────────────────────────────────────────────────

// On iOS: auto-register via constructor (symbols resolved via -undefined dynamic_lookup)
#[cfg(target_os = "ios")]
#[used]
#[unsafe(link_section = "__DATA,__mod_init_func")]
static REGISTER: extern "C" fn() = {
    extern "C" fn register() {
        unsafe {
${registrations.join("\n")}
${asyncRegistrations.join("\n")}
        }
    }
    register
};

// On Android dev: host calls nativ_init after dlopen, passing the registry function pointer.
// Android linker namespaces prevent dlsym(RTLD_DEFAULT) from finding host symbols.
#[cfg(all(target_os = "android", not(unified)))]
static mut NATIV_REGISTER_SYNC: Option<unsafe extern "C" fn(*const c_char, *const c_char, NativSyncFn)> = None;
#[cfg(all(target_os = "android", not(unified)))]
static mut NATIV_REGISTER_ASYNC: Option<unsafe extern "C" fn(*const c_char, *const c_char, NativAsyncFn)> = None;

#[cfg(all(target_os = "android", not(unified)))]
#[unsafe(no_mangle)]
pub extern "C" fn nativ_init(reg_fn: *mut std::ffi::c_void) {
    unsafe {
        NATIV_REGISTER_SYNC = Some(std::mem::transmute(reg_fn));
        if let Some(reg) = NATIV_REGISTER_SYNC {
${registrations.map((r) => r.replace(/nativ_register_sync/g, "reg")).join("\n")}
        }
    }
}

#[cfg(all(target_os = "android", not(unified)))]
#[unsafe(no_mangle)]
pub extern "C" fn nativ_init_async(reg_fn: *mut std::ffi::c_void) {
    unsafe {
        NATIV_REGISTER_ASYNC = Some(std::mem::transmute(reg_fn));
        if let Some(reg) = NATIV_REGISTER_ASYNC {
${asyncRegistrations.map((r) => r.replace(/nativ_register_async/g, "reg")).join("\n")}
        }
    }
}

// On Android production (unified crate): direct extern, constructor registration.
// All code is in the same .so — symbols resolved at link time.
#[cfg(all(target_os = "android", unified))]
unsafe extern "C" {
    fn nativ_register_sync(module_id: *const c_char, fn_name: *const c_char, f: NativSyncFn);
    fn nativ_register_async(module_id: *const c_char, fn_name: *const c_char, f: NativAsyncFn);
}

#[cfg(all(target_os = "android", unified))]
#[used]
#[unsafe(link_section = ".init_array")]
static REGISTER_ANDROID: extern "C" fn() = {
    extern "C" fn register() {
        unsafe {
${registrations.join("\n")}
${asyncRegistrations.join("\n")}
        }
    }
    register
};
`;
}

module.exports = {
  compileRustDylib,
  ensureRustCrate,
  generateFunctionWrapper,
  generateComponentWrapper,
};
