// haptics.mm — Haptic feedback via UIKit, exported to JavaScript

#import "RNAnywhere.h"
#import <UIKit/UIKit.h>
#include <string>

RNA_EXPORT(sync, main)
std::string tapLight() {
    UIImpactFeedbackGenerator *gen = [[UIImpactFeedbackGenerator alloc] initWithStyle:UIImpactFeedbackStyleLight];
    [gen prepare];
    [gen impactOccurred];
    return "light";
}

RNA_EXPORT(sync, main)
std::string tapMedium() {
    UIImpactFeedbackGenerator *gen = [[UIImpactFeedbackGenerator alloc] initWithStyle:UIImpactFeedbackStyleMedium];
    [gen prepare];
    [gen impactOccurred];
    return "medium";
}

RNA_EXPORT(sync, main)
std::string tapHeavy() {
    UIImpactFeedbackGenerator *gen = [[UIImpactFeedbackGenerator alloc] initWithStyle:UIImpactFeedbackStyleHeavy];
    [gen prepare];
    [gen impactOccurred];
    return "heavy";
}

RNA_EXPORT(sync, main)
std::string notifySuccess() {
    UINotificationFeedbackGenerator *gen = [[UINotificationFeedbackGenerator alloc] init];
    [gen notificationOccurred:UINotificationFeedbackTypeSuccess];
    return "success";
}
