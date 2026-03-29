/// Ferrum C ABI helper functions for converting between HermesABIValue and ObjC types.
/// Used by generated bridge code — zero JSI in the path.
///
/// Callers must #include <hermes_abi/hermes_abi.h> BEFORE this header
/// to get the full type declarations.

#pragma once

#import <Foundation/Foundation.h>

#ifdef __cplusplus
extern "C" {
#endif

#ifdef HERMES_ABI_HERMES_ABI_H

// --- Value inspection ---

bool ferrum_abi_is_null_or_undefined(const struct HermesABIValue *val);

// --- Extraction: HermesABIValue → C/ObjC types ---

bool ferrum_abi_get_bool(const struct HermesABIValue *val);

double ferrum_abi_get_number(const struct HermesABIValue *val);

NSString *ferrum_abi_get_string(
    struct HermesABIRuntime *rt,
    const struct HermesABIRuntimeVTable *vt,
    const struct HermesABIValue *val);

id ferrum_abi_get_object(
    struct HermesABIRuntime *rt,
    const struct HermesABIRuntimeVTable *vt,
    const struct HermesABIValue *val);

NSArray *ferrum_abi_get_array(
    struct HermesABIRuntime *rt,
    const struct HermesABIRuntimeVTable *vt,
    const struct HermesABIValue *val);

// --- Construction: C/ObjC types → HermesABIValue ---

struct HermesABIValueOrError ferrum_abi_make_undefined(void);
struct HermesABIValueOrError ferrum_abi_from_bool(bool val);
struct HermesABIValueOrError ferrum_abi_from_number(double val);

struct HermesABIValueOrError ferrum_abi_from_string(
    struct HermesABIRuntime *rt,
    const struct HermesABIRuntimeVTable *vt,
    NSString *str);

struct HermesABIValueOrError ferrum_abi_from_object(
    struct HermesABIRuntime *rt,
    const struct HermesABIRuntimeVTable *vt,
    id obj);

// --- Callback wrapping: JS function → ObjC block ---

/// Wrap a JS function (received as HermesABIValue) into an ObjC block
/// compatible with RCTResponseSenderBlock (void (^)(NSArray *)).
/// The block captures the JS function and, when called, uses the
/// CallInvoker to schedule invocation on the JS thread via C ABI.
typedef void (^FerrumCallbackBlock)(NSArray *response);

/// jsInvokerPtr must be a pointer to std::shared_ptr<CallInvoker> (cast to void*).
FerrumCallbackBlock ferrum_abi_wrap_callback(
    struct HermesABIRuntime *rt,
    const struct HermesABIRuntimeVTable *vt,
    const struct HermesABIValue *callbackVal,
    void *jsInvokerPtr);

#endif // HERMES_ABI_HERMES_ABI_H

#ifdef __cplusplus
}
#endif
