// haptics.mm — Haptic feedback via UIKit, exported to JavaScript

#import "Nativ.h"
#import <UIKit/UIKit.h>
#include <string>

NATIV_EXPORT(sync, main)
std::string tapLight() {
    UIImpactFeedbackGenerator *gen = [[UIImpactFeedbackGenerator alloc] initWithStyle:UIImpactFeedbackStyleLight];
    [gen prepare];
    [gen impactOccurred];
    return "light";
}

NATIV_EXPORT(sync, main)
std::string tapMedium() {
    UIImpactFeedbackGenerator *gen = [[UIImpactFeedbackGenerator alloc] initWithStyle:UIImpactFeedbackStyleMedium];
    [gen prepare];
    [gen impactOccurred];
    return "medium";
}

NATIV_EXPORT(sync, main)
std::string tapHeavy() {
    UIImpactFeedbackGenerator *gen = [[UIImpactFeedbackGenerator alloc] initWithStyle:UIImpactFeedbackStyleHeavy];
    [gen prepare];
    [gen impactOccurred];
    return "heavy";
}

NATIV_EXPORT(sync, main)
std::string notifySuccess() {
    UINotificationFeedbackGenerator *gen = [[UINotificationFeedbackGenerator alloc] init];
    [gen notificationOccurred:UINotificationFeedbackTypeSuccess];
    return "success";
}
