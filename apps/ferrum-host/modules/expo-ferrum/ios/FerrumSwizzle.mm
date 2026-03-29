/// Ferrum: Swizzle createJSRuntimeFactory on the RN delegate to inject
/// FerrumRuntimeFactory. Everything in the Expo Module — no AppDelegate changes.

#import <Foundation/Foundation.h>
#import <objc/runtime.h>

// Our factory (defined in FerrumRuntimeFactory.mm)
extern "C" void *jsrt_create_ferrum_factory(void);

// We swizzle on RCTDefaultReactNativeFactoryDelegate which implements
// createJSRuntimeFactory. All subclasses (ExpoReactNativeFactoryDelegate,
// ReactNativeDelegate) inherit it.

@interface FerrumSwizzleHelper : NSObject
@end

@implementation FerrumSwizzleHelper

+ (void)load {
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    Class cls = NSClassFromString(@"RCTDefaultReactNativeFactoryDelegate");
    if (!cls) {
      NSLog(@"[Ferrum] RCTDefaultReactNativeFactoryDelegate not found");
      return;
    }

    SEL originalSel = NSSelectorFromString(@"createJSRuntimeFactory");
    Method originalMethod = class_getInstanceMethod(cls, originalSel);
    if (!originalMethod) {
      NSLog(@"[Ferrum] createJSRuntimeFactory not found");
      return;
    }

    // Save original IMP
    typedef void *(*OriginalIMP)(id, SEL);
    __block OriginalIMP originalIMP = (OriginalIMP)method_getImplementation(originalMethod);

    // Replace with our implementation
    IMP newIMP = imp_implementationWithBlock(^void *(id self_) {
      NSLog(@"[Ferrum] createJSRuntimeFactory swizzled — returning FerrumRuntimeFactory");
      return jsrt_create_ferrum_factory();
    });

    method_setImplementation(originalMethod, newIMP);
    NSLog(@"[Ferrum] Swizzled createJSRuntimeFactory on RCTDefaultReactNativeFactoryDelegate");
  });
}

@end
