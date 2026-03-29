/// Ferrum C ABI helpers — convert between HermesABIValue and ObjC types.

#include <hermes_abi/hermes_abi.h>
#import "FerrumABIHelpers.h"
#include <ReactCommon/CallInvoker.h>
#include <cstring>
#include <cstdlib>

// Growable buffer implementation for get_utf8_from_string
static void ferrum_buf_try_grow(struct HermesABIGrowableBuffer *buf, size_t sz) {
  if (sz <= buf->size) return;
  uint8_t *newData = (uint8_t *)realloc(buf->data, sz);
  if (newData) {
    buf->data = newData;
    buf->size = sz;
  }
}

static const struct HermesABIGrowableBufferVTable kGrowableBufferVTable = {
  ferrum_buf_try_grow,
};

// Forward declarations for mutual recursion
static id valueToObjC(
    struct HermesABIRuntime *rt,
    const struct HermesABIRuntimeVTable *vt,
    const struct HermesABIValue *val);
static HermesABIValue objcToValue(
    struct HermesABIRuntime *rt,
    const struct HermesABIRuntimeVTable *vt,
    id obj);

extern "C" {

bool ferrum_abi_is_null_or_undefined(const struct HermesABIValue *val) {
  return val->kind == HermesABIValueKindUndefined ||
         val->kind == HermesABIValueKindNull;
}

bool ferrum_abi_get_bool(const struct HermesABIValue *val) {
  return val->data.boolean;
}

double ferrum_abi_get_number(const struct HermesABIValue *val) {
  return val->data.number;
}

NSString *ferrum_abi_get_string(
    struct HermesABIRuntime *rt,
    const struct HermesABIRuntimeVTable *vt,
    const struct HermesABIValue *val) {
  if (val->kind != HermesABIValueKindString) return nil;
  HermesABIString str = {val->data.pointer};
  HermesABIGrowableBuffer buf = {&kGrowableBufferVTable, nullptr, 0, 0};
  vt->get_utf8_from_string(rt, str, &buf);
  NSString *result = [[NSString alloc] initWithBytes:buf.data
                                              length:buf.used
                                            encoding:NSUTF8StringEncoding];
  if (buf.data) free(buf.data);
  return result;
}

NSArray *ferrum_abi_get_array(
    struct HermesABIRuntime *rt,
    const struct HermesABIRuntimeVTable *vt,
    const struct HermesABIValue *val) {
  if (val->kind != HermesABIValueKindObject) return @[];

  HermesABIArray arr;
  arr.pointer = val->data.pointer;

  auto sizeOrErr = vt->get_array_length(rt, arr);
  if (sizeOrErr.is_error) return @[];
  size_t len = sizeOrErr.data.val;

  NSMutableArray *result = [NSMutableArray arrayWithCapacity:len];
  for (size_t i = 0; i < len; i++) {
    HermesABIValue indexVal;
    indexVal.kind = HermesABIValueKindNumber;
    indexVal.data.number = i;
    auto elemOrErr = vt->get_object_property_from_value(
        rt, (HermesABIObject){arr.pointer}, &indexVal);
    id elem = valueToObjC(rt, vt, &elemOrErr.value);
    [result addObject:elem ?: [NSNull null]];
  }
  return result;
}

id ferrum_abi_get_object(
    struct HermesABIRuntime *rt,
    const struct HermesABIRuntimeVTable *vt,
    const struct HermesABIValue *val) {
  // Object-to-NSDictionary requires property enumeration which isn't
  // in the C ABI vtable. For now, return nil.
  // Async-storage only uses arrays and callbacks, not plain objects.
  return nil;
}

// --- Construction ---

struct HermesABIValueOrError ferrum_abi_make_undefined(void) {
  struct HermesABIValueOrError r;
  r.value.kind = HermesABIValueKindUndefined;
  return r;
}

struct HermesABIValueOrError ferrum_abi_from_bool(bool val) {
  struct HermesABIValueOrError r;
  r.value.kind = HermesABIValueKindBoolean;
  r.value.data.boolean = val;
  return r;
}

struct HermesABIValueOrError ferrum_abi_from_number(double val) {
  struct HermesABIValueOrError r;
  r.value.kind = HermesABIValueKindNumber;
  r.value.data.number = val;
  return r;
}

struct HermesABIValueOrError ferrum_abi_from_string(
    struct HermesABIRuntime *rt,
    const struct HermesABIRuntimeVTable *vt,
    NSString *str) {
  if (!str) return ferrum_abi_make_undefined();
  const char *utf8 = [str UTF8String];
  size_t len = strlen(utf8);
  auto strOrErr = vt->create_string_from_utf8(rt, (const uint8_t *)utf8, len);
  if (strOrErr.ptr_or_error & 1) return ferrum_abi_make_undefined();
  struct HermesABIValueOrError r;
  r.value.kind = HermesABIValueKindString;
  r.value.data.pointer = (struct HermesABIManagedPointer *)strOrErr.ptr_or_error;
  return r;
}

struct HermesABIValueOrError ferrum_abi_from_object(
    struct HermesABIRuntime *rt,
    const struct HermesABIRuntimeVTable *vt,
    id obj) {
  struct HermesABIValueOrError r;
  r.value = objcToValue(rt, vt, obj);
  return r;
}

// --- Callback wrapping ---

FerrumCallbackBlock ferrum_abi_wrap_callback(
    struct HermesABIRuntime *rt,
    const struct HermesABIRuntimeVTable *vt,
    const struct HermesABIValue *callbackVal,
    void *jsInvokerPtr) {
  if (callbackVal->kind != HermesABIValueKindObject) {
    return [^(NSArray *response) {} copy];
  }

  // Clone the JS function. The borrowed wrapper now registers custom GC roots
  // (vendored fix), so cloned values survive garbage collection.
  HermesABIObject fn = {callbackVal->data.pointer};
  HermesABIObject clonedFn = vt->clone_object(rt, fn);

  struct HermesABIRuntime *capturedRt = rt;
  const struct HermesABIRuntimeVTable *capturedVt = vt;
  HermesABIManagedPointer *capturedFnPtr = clonedFn.pointer;
  auto invoker = *reinterpret_cast<std::shared_ptr<facebook::react::CallInvoker> *>(jsInvokerPtr);

  return [^(NSArray *response) {
    invoker->invokeAsync([=]() {
      size_t argCount = response.count;
      HermesABIValue *args = (HermesABIValue *)calloc(argCount, sizeof(HermesABIValue));
      for (size_t i = 0; i < argCount; i++) {
        args[i] = objcToValue(capturedRt, capturedVt, response[i]);
      }
      HermesABIValue thisArg;
      thisArg.kind = HermesABIValueKindUndefined;
      HermesABIFunction jsFn;
      jsFn.pointer = capturedFnPtr;
      capturedVt->call(capturedRt, jsFn, &thisArg, args, argCount);
      free(args);
      // Release the cloned reference
      capturedFnPtr->vtable->invalidate(capturedFnPtr);
    });
  } copy];
}

} // extern "C"

// --- Static helpers (outside extern "C" for C++ compatibility) ---

static id valueToObjC(
    struct HermesABIRuntime *rt,
    const struct HermesABIRuntimeVTable *vt,
    const struct HermesABIValue *val) {
  switch (val->kind) {
    case HermesABIValueKindUndefined:
    case HermesABIValueKindNull:
      return [NSNull null];
    case HermesABIValueKindBoolean:
      return @(val->data.boolean);
    case HermesABIValueKindNumber:
      return @(val->data.number);
    case HermesABIValueKindString:
      return ferrum_abi_get_string(rt, vt, val);
    case HermesABIValueKindObject: {
      HermesABIObject obj = {val->data.pointer};
      auto isArr = vt->object_is_array(rt, obj);
      if (!(isArr.bool_or_error & 1) && (isArr.bool_or_error >> 1)) {
        return ferrum_abi_get_array(rt, vt, val);
      }
      // Plain object — can't enumerate properties via C ABI yet
      return [NSNull null];
    }
    default:
      return [NSNull null];
  }
}

static HermesABIValue objcToValue(
    struct HermesABIRuntime *rt,
    const struct HermesABIRuntimeVTable *vt,
    id obj) {
  if (!obj || [obj isKindOfClass:[NSNull class]]) {
    HermesABIValue v;
    v.kind = HermesABIValueKindNull;
    return v;
  }
  if ([obj isKindOfClass:[NSNumber class]]) {
    NSNumber *num = obj;
    if (strcmp([num objCType], @encode(BOOL)) == 0 ||
        strcmp([num objCType], @encode(char)) == 0) {
      HermesABIValue v;
      v.kind = HermesABIValueKindBoolean;
      v.data.boolean = [num boolValue];
      return v;
    }
    HermesABIValue v;
    v.kind = HermesABIValueKindNumber;
    v.data.number = [num doubleValue];
    return v;
  }
  if ([obj isKindOfClass:[NSString class]]) {
    return ferrum_abi_from_string(rt, vt, obj).value;
  }
  if ([obj isKindOfClass:[NSArray class]]) {
    NSArray *arr = obj;
    // Create a proper JS array via create_object then set elements
    auto objOrErr = vt->create_object(rt);
    if (objOrErr.ptr_or_error & 1) {
      HermesABIValue v;
      v.kind = HermesABIValueKindNull;
      return v;
    }
    HermesABIObject jsArr;
    jsArr.pointer = (HermesABIManagedPointer *)objOrErr.ptr_or_error;
    for (NSUInteger i = 0; i < arr.count; i++) {
      HermesABIValue key;
      key.kind = HermesABIValueKindNumber;
      key.data.number = i;
      HermesABIValue val = objcToValue(rt, vt, arr[i]);
      vt->set_object_property_from_value(rt, jsArr, &key, &val);
    }
    HermesABIValue v;
    v.kind = HermesABIValueKindObject;
    v.data.pointer = jsArr.pointer;
    return v;
  }
  if ([obj isKindOfClass:[NSDictionary class]]) {
    NSDictionary *dict = obj;
    auto objOrErr = vt->create_object(rt);
    if (objOrErr.ptr_or_error & 1) {
      HermesABIValue v;
      v.kind = HermesABIValueKindNull;
      return v;
    }
    HermesABIObject jsObj;
    jsObj.pointer = (HermesABIManagedPointer *)objOrErr.ptr_or_error;
    for (NSString *key in dict) {
      auto strOrErr = vt->create_string_from_utf8(
          rt, (const uint8_t *)[key UTF8String],
          [key lengthOfBytesUsingEncoding:NSUTF8StringEncoding]);
      if (strOrErr.ptr_or_error & 1) continue;
      auto pnOrErr = vt->create_propnameid_from_string(
          rt, (HermesABIString){(HermesABIManagedPointer *)strOrErr.ptr_or_error});
      if (pnOrErr.ptr_or_error & 1) {
        ((HermesABIManagedPointer *)strOrErr.ptr_or_error)->vtable->invalidate(
            (HermesABIManagedPointer *)strOrErr.ptr_or_error);
        continue;
      }
      HermesABIValue val = objcToValue(rt, vt, dict[key]);
      vt->set_object_property_from_propnameid(
          rt, jsObj,
          (HermesABIPropNameID){(HermesABIManagedPointer *)pnOrErr.ptr_or_error},
          &val);
      ((HermesABIManagedPointer *)strOrErr.ptr_or_error)->vtable->invalidate(
          (HermesABIManagedPointer *)strOrErr.ptr_or_error);
      ((HermesABIManagedPointer *)pnOrErr.ptr_or_error)->vtable->invalidate(
          (HermesABIManagedPointer *)pnOrErr.ptr_or_error);
    }
    HermesABIValue v;
    v.kind = HermesABIValueKindObject;
    v.data.pointer = jsObj.pointer;
    return v;
  }
  // Fallback
  HermesABIValue v;
  v.kind = HermesABIValueKindNull;
  return v;
}
