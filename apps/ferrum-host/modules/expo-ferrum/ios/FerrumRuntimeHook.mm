/// Ferrum: Swizzle didInitializeRuntime to wrap __turboModuleProxy
/// and inject C ABI bridges.

#import <Foundation/Foundation.h>
#import <objc/runtime.h>
#include <jsi/jsi.h>

// Wrap __turboModuleProxy to intercept module creation
extern "C" void ferrum_install_abi_module_getter(void *rt);

// We swizzle on ExpoReactNativeFactoryDelegate which implements
// didInitializeRuntime via the RCTHostRuntimeDelegate protocol.

@interface FerrumRuntimeHookHelper : NSObject
@end

@implementation FerrumRuntimeHookHelper

+ (void)load {
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    // Try Expo's delegate first, then fall back to RN's base class
    Class cls = NSClassFromString(@"ExpoReactNativeFactoryDelegate");
    if (!cls) {
      cls = NSClassFromString(@"RCTDefaultReactNativeFactoryDelegate");
    }
    if (!cls) {
      NSLog(@"[Ferrum] No runtime delegate class found");
      return;
    }

    SEL originalSel = NSSelectorFromString(@"host:didInitializeRuntime:");
    Method originalMethod = class_getInstanceMethod(cls, originalSel);
    if (!originalMethod) {
      NSLog(@"[Ferrum] host:didInitializeRuntime: not found");
      return;
    }

    // Save original IMP
    // Signature: - (void)host:(nonnull RCTHost *)host didInitializeRuntime:(jsi::Runtime &)runtime
    typedef void (*OriginalIMP)(id, SEL, id, void *);
    __block OriginalIMP originalIMP = (OriginalIMP)method_getImplementation(originalMethod);

    // Replace with our implementation
    IMP newIMP = imp_implementationWithBlock(^void (id self_, id host, void *rt) {
      NSLog(@"[Ferrum] didInitializeRuntime swizzled");

      // Call original
      originalIMP(self_, originalSel, host, rt);

      // Wrap __turboModuleProxy with our C ABI bridge interceptor
      NSLog(@"[Ferrum] Wrapping __turboModuleProxy...");
      ferrum_install_abi_module_getter(rt);
      NSLog(@"[Ferrum] __turboModuleProxy wrapped");
    });

    method_setImplementation(originalMethod, newIMP);
    NSLog(@"[Ferrum] Swizzled didInitializeRuntime on %@", NSStringFromClass(cls));
  });
}

@end
