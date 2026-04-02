// device_info.mm — iOS platform APIs exported to JavaScript
// ObjC++ gives full access to UIKit, Foundation, and any iOS framework.

#import <UIKit/UIKit.h>
#import <sys/utsname.h>
#include <string>

#include "RNAnywhere.h"

RNA_EXPORT(sync, main)
std::string getColorScheme() {
    UITraitCollection *traits = [UITraitCollection currentTraitCollection];
    switch (traits.userInterfaceStyle) {
        case UIUserInterfaceStyleDark:  return "dark";
        case UIUserInterfaceStyleLight: return "light";
        default: return "unknown";
    }
}

RNA_EXPORT(sync, main)
double getScreenBrightness() {
    return (double)[UIScreen mainScreen].brightness;
}

RNA_EXPORT(sync)
std::string getDeviceModel() {
    struct utsname systemInfo;
    uname(&systemInfo);
    return std::string(systemInfo.machine);
}

RNA_EXPORT(sync, main)
double getStatusBarHeight() {
    UIWindowScene *scene = (UIWindowScene *)[[UIApplication sharedApplication].connectedScenes anyObject];
    return (double)scene.statusBarManager.statusBarFrame.size.height;
}
