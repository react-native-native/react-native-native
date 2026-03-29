/// FerrumBench — minimal TurboModule for benchmarking JSI vs C ABI paths.
///
/// Uses RCT_EXPORT_SYNCHRONOUS_TYPED_METHOD for interop compatibility.

#import <React/RCTBridgeModule.h>

@interface FerrumBench : NSObject <RCTBridgeModule>
@end

@implementation FerrumBench

RCT_EXPORT_MODULE()

RCT_EXPORT_SYNCHRONOUS_TYPED_METHOD(NSNumber *, add:(double)a b:(double)b) {
  return @(a + b);
}

RCT_EXPORT_SYNCHRONOUS_TYPED_METHOD(NSNumber *, negate:(BOOL)a) {
  return @(!a);
}

RCT_EXPORT_SYNCHRONOUS_TYPED_METHOD(NSString *, echo:(NSString *)s) {
  return s;
}

@end
