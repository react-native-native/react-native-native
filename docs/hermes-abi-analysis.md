# Hermes Stable C ABI Analysis

> Phase 0 research for Project Ferrum — 2026-03-28

## Executive Summary

The Hermes stable C ABI (`hermes_abi.h`) exposes a **complete and sufficient** API surface for Ferrum's Phase 0 goals. It supports runtime creation, JS evaluation (source and bytecode), global object access, host function registration, full object property manipulation, and error handling — all through a pure C interface with no C++ dependency. **Phase 0 open question #1 is answered affirmatively: JS global registration works without JSI C++.**

## ABI Architecture

### Design Principles

The Hermes ABI provides a stable binary boundary using C-linkage function pointers organized into vtables. Unlike JSI (a C++ API subject to name mangling and compiler-specific ABI variations), the C ABI guarantees cross-toolchain compatibility. This is exactly what Ferrum needs — Rust can call `extern "C"` functions directly without any C++ interop layer.

### VTable Pattern

The runtime is represented as an opaque `HermesABIRuntime` struct that carries a pointer to `HermesABIRuntimeVTable` — a struct of C function pointers implementing every operation. The entry point:

```c
// Get the global vtable — single entry point to Hermes
const HermesABIVTable *get_hermes_abi_vtable(void);

// Create a runtime from the vtable
HermesABIRuntime *make_hermes_runtime(HermesABIRuntimeConfig *config);
```

All subsequent operations dispatch through function pointers in the vtable, passing the runtime handle as the first argument. This is effectively a manually-constructed trait object — maps cleanly to Rust.

## Complete API Surface

### Runtime Lifecycle

| Function | Signature | Purpose |
|----------|-----------|---------|
| `make_hermes_runtime` | `(config) → HermesABIRuntime*` | Create new runtime instance |
| `release` | `(runtime) → void` | Destroy runtime, free resources |

### Code Evaluation

| Function | Signature | Purpose |
|----------|-----------|---------|
| `evaluate_javascript_source` | `(buffer, source_url, url_len) → ValueOrError` | Evaluate JS source text |
| `evaluate_hermes_bytecode` | `(buffer, source_url, url_len) → ValueOrError` | Evaluate precompiled Hermes bytecode |
| `is_hermes_bytecode` | `(buffer, len) → bool` | Validate bytecode magic number |

The `buffer` parameter is a `HermesABIBuffer` — an immutable data buffer with a vtable containing a `release` callback. Rust can implement this to hand Hermes a pointer to a `Vec<u8>` or memory-mapped file.

### Value Types

```c
enum HermesABIValueKind {
    Undefined, Null, Boolean, Error, Number,
    Symbol, BigInt, String, Object
};

struct HermesABIValue {
    HermesABIValueKind kind;
    union { bool boolean; double number; void *pointer; int error_code; } data;
};
```

Managed pointer types (reference-counted by Hermes GC):
- `HermesABIObject`, `HermesABIArray`, `HermesABIString`, `HermesABIBigInt`
- `HermesABISymbol`, `HermesABIFunction`, `HermesABIArrayBuffer`, `HermesABIPropNameID`
- `HermesABIWeakObject`

Each has a corresponding `*OrError` variant for fallible operations.

### Error Handling

```c
enum HermesABIErrorCode { NativeException, JSError };

struct HermesABIValueOrError  { /* discriminated union: value or error */ };
struct HermesABIVoidOrError   { /* void or error */ };
struct HermesABIBoolOrError   { /* bool or error */ };
```

Error retrieval:
- `get_and_clear_js_error_value()` → `HermesABIValue` — the thrown JS value
- `get_and_clear_native_exception_message(growable_buffer)` — native error string
- `set_js_error_value(value)` — throw JS exception from host
- `set_native_exception_message(utf8, len)` — throw native exception from host

This maps cleanly to Rust `Result<T, E>` patterns.

### Global Object Access

```c
get_global_object() → HermesABIObject
```

Returns the JS global object. Combined with property setters, this is how Ferrum registers Rust functions as JS globals.

### Object Property Operations

| Function | Purpose |
|----------|---------|
| `create_object()` | Create empty JS object |
| `has_object_property_from_value(obj, key)` | Check property existence |
| `has_object_property_from_propnameid(obj, name)` | Check property (pre-resolved name) |
| `get_object_property_from_value(obj, key)` | Read property by value key |
| `get_object_property_from_propnameid(obj, name)` | Read property by PropNameID |
| `set_object_property_from_value(obj, key, value)` | Write property by value key |
| `set_object_property_from_propnameid(obj, name, value)` | Write property by PropNameID |
| `get_object_property_names(obj)` | Enumerate string keys |
| `set_object_external_memory_pressure(obj, bytes)` | Hint GC about native memory |

### Host Function Registration (Critical for Phase 0)

```c
// Host function vtable — Rust implements these
struct HermesABIHostFunctionVTable {
    void (*release)(HermesABIHostFunction *self);
    HermesABIValueOrError (*call)(
        HermesABIHostFunction *self,
        HermesABIRuntime *runtime,
        HermesABIValue this_arg,
        const HermesABIValue *args,
        size_t arg_count
    );
};

// Create a JS function backed by a host (Rust) function
create_function_from_host_function(
    propnameid name,
    unsigned int param_count,
    HermesABIHostFunction *host_fn
) → HermesABIFunctionOrError
```

**This is the key API for Ferrum.** The flow to register `rust_add` as a JS global:

1. Implement `HermesABIHostFunctionVTable` with `call` pointing to a Rust `extern "C"` fn
2. Call `create_function_from_host_function("rust_add", 2, host_fn)` → get `HermesABIFunction`
3. Call `get_global_object()` → get global object
4. Call `set_object_property_from_propnameid(global, "rust_add", fn_value)` → done

JS code can now call `rust_add(1, 2)` and it synchronously invokes the Rust function.

### Host Objects

```c
struct HermesABIHostObjectVTable {
    void (*release)(HermesABIHostObject *self);
    HermesABIValueOrError (*get)(self, runtime, name);
    HermesABIVoidOrError (*set)(self, runtime, name, value);
    HermesABIPropNameIDListPtrOrError (*get_own_keys)(self, runtime);
};
```

Allows exposing Rust structs as JS objects with custom property access traps. Not needed for Phase 0 but essential for later phases.

### Function Calling

| Function | Purpose |
|----------|---------|
| `call(fn, this, args, count)` | Call JS function from host |
| `call_as_constructor(fn, args, count)` | Call with `new` |
| `get_host_function(fn)` | Retrieve host function pointer (or null) |
| `instance_of(obj, ctor)` | `instanceof` check |

### String Operations

| Function | Purpose |
|----------|---------|
| `create_string_from_utf8(ptr, len)` | Create JS string from UTF-8 |
| `get_utf8_from_string(str, growable_buffer)` | Extract UTF-8 from JS string |
| `clone_string(str)` | Clone managed string reference |

### PropNameID Operations

| Function | Purpose |
|----------|---------|
| `create_propnameid_from_string(str)` | Create property name from string |
| `create_propnameid_from_symbol(sym)` | Create property name from symbol |
| `prop_name_id_equals(a, b)` | Compare property names |
| `get_utf8_from_propnameid(name, buf)` | Extract UTF-8 from PropNameID |

### Array Operations

| Function | Purpose |
|----------|---------|
| `create_array(length)` | Create JS array |
| `get_array_length(arr)` | Get array length |

Array element access uses the object property API with numeric indices.

### ArrayBuffer / SharedArrayBuffer

| Function | Purpose |
|----------|---------|
| `create_arraybuffer_from_external_data(mutable_buffer)` | Zero-copy ArrayBuffer from host memory |
| `get_arraybuffer_data(ab)` | Get raw pointer to buffer data |
| `get_arraybuffer_size(ab)` | Get buffer byte length |

**Critical for Ferrum's SharedArrayBuffer channels.** The `mutable_buffer` vtable lets Rust own the backing memory while JS reads/writes through the ArrayBuffer view.

### BigInt Operations

| Function | Purpose |
|----------|---------|
| `create_bigint_from_int64(val)` | Create from i64 |
| `create_bigint_from_uint64(val)` | Create from u64 |
| `bigint_is_int64(bi)` / `bigint_is_uint64(bi)` | Range checks |
| `bigint_truncate_to_uint64(bi)` | Extract value |
| `bigint_to_string(bi, radix)` | String representation |

### Native State

| Function | Purpose |
|----------|---------|
| `get_native_state(obj)` | Get attached native data |
| `set_native_state(obj, state)` | Attach native data to JS object |

Allows attaching Rust-owned data to JS objects, released automatically on GC. Uses a vtable with a `release` callback.

### Microtask Queue

| Function | Purpose |
|----------|---------|
| `drain_microtasks(max_hint)` | Process pending microtasks |

Returns `true` when queue is empty. `max_hint = -1` for unlimited. Essential for Promise resolution.

### Equality

| Function | Purpose |
|----------|---------|
| `strict_equals_symbol(a, b)` | Symbol strict equality |
| `strict_equals_bigint(a, b)` | BigInt strict equality |
| `strict_equals_string(a, b)` | String strict equality |
| `strict_equals_object(a, b)` | Object identity equality |

### Type Checks

| Function | Purpose |
|----------|---------|
| `object_is_array(obj)` | `Array.isArray()` equivalent |
| `object_is_arraybuffer(obj)` | ArrayBuffer check |
| `object_is_function(obj)` | Function check |

## Buffer Types (Host → Hermes Data Transfer)

```c
// Immutable buffer (for source code / bytecode)
struct HermesABIBuffer {
    void (*release)(HermesABIBuffer *self);
    const uint8_t *data;
    size_t size;
};

// Mutable buffer (for ArrayBuffer backing store)
struct HermesABIMutableBuffer {
    void (*release)(HermesABIMutableBuffer *self);
    uint8_t *data;
    size_t size;
};

// Growable buffer (for string extraction — Hermes calls try_grow_to)
struct HermesABIGrowableBuffer {
    bool (*try_grow_to)(HermesABIGrowableBuffer *self, size_t new_size);
    uint8_t *data;
    size_t size;
};
```

All three use vtable patterns with `release` callbacks — Rust implements these to control memory ownership.

## Answer to Phase 0 Open Question #1

> Does Hermes stable C ABI expose enough surface for JS global registration without JSI C++?

**Yes, definitively.** The complete path is:

1. `get_hermes_abi_vtable()` — obtain the ABI entry point
2. `make_hermes_runtime(config)` — create a runtime
3. `create_function_from_host_function(name, arity, vtable_ptr)` — wrap a Rust `extern "C"` fn
4. `get_global_object()` — get JS `globalThis`
5. `set_object_property_from_propnameid(global, name, fn_as_value)` — register as global

No JSI, no C++, no cxx crate needed. Pure C function pointers all the way down.

## Gaps and Limitations

### No Gaps for Phase 0
The C ABI provides everything needed for Phase 0:
- Runtime creation and destruction
- JS source and bytecode evaluation
- Host function registration on globals
- Number/string value conversion
- Error handling

### Minor Gaps for Later Phases
1. **No direct `console.log` binding** — must be manually installed as a host function on the `console` object
2. **No ES module support** through the C ABI — only script evaluation
3. **No WeakRef/FinalizationRegistry host hooks** — only `HermesABIWeakObject`
4. **No source map support** — bytecode evaluation doesn't accept source maps through the ABI
5. **Manual lifecycle management** — all managed pointers must be explicitly released (no RAII). Rust's `Drop` trait handles this naturally.

### Ergonomics vs JSI
The C ABI is lower-level than JSI — no templates, no RAII, no operator overloading. But this is a feature for Rust: the flat C interface maps directly to `extern "C"` declarations and `#[repr(C)]` structs.

## Rust Binding Strategy

### Recommended Approach for `hermes-abi-rs`

```
Layer 1: Raw FFI        — #[repr(C)] structs + extern "C" fn declarations
Layer 2: Safe wrappers  — Drop-based RAII, Result<T, HermesError>, &str/String conversions
Layer 3: Ergonomic API  — runtime.register_global_fn("rust_add", |args| { ... })
```

Key implementation notes:
- All vtable structs map to `#[repr(C)]` with function pointer fields
- `HermesABIValueOrError` → `Result<HermesValue, HermesError>`
- `HermesABIHostFunctionVTable.call` → Rust closure via trampoline pattern
- `HermesABIBuffer.release` → Rust `Box::from_raw` / `Drop`
- `HermesABIGrowableBuffer.try_grow_to` → Rust `Vec::reserve` wrapper

## Sources

- [Hermes GitHub repository](https://github.com/facebook/hermes)
- [Hermes Public API and Embedding — DeepWiki](https://deepwiki.com/facebook/hermes/9-public-api-and-embedding)
- [Hermes VM documentation](https://github.com/facebook/hermes/blob/main/doc/VM.md)
- [Hermes static_h branch](https://github.com/facebook/hermes/tree/static_h) (stable C ABI development)
