// GradientBox.mm — ObjC++ component with auto-populated props.
// Just define the props struct and mount(). The bridge handles extraction.

#import <UIKit/UIKit.h>
#import <QuartzCore/QuartzCore.h>
#include "Nativ.h"

struct GradientBoxProps {
    std::string title = "Gradient from ObjC++";
    double corner_radius = 12.0;
};

NATIV_COMPONENT(gradientbox, GradientBoxProps)

static void mount(void* view_ptr, float width, float height, GradientBoxProps props) {
    UIView* view = (__bridge UIView*)view_ptr;

    CAGradientLayer* gradient = [CAGradientLayer layer];
    gradient.frame = CGRectMake(0, 0, width, height);
    gradient.colors = @[
        (id)[UIColor colorWithRed:0.56 green:0.07 blue:0.99 alpha:1.0].CGColor,
        (id)[UIColor colorWithRed:0.89 green:0.59 blue:0.95 alpha:1.0].CGColor,
    ];
    gradient.startPoint = CGPointMake(1, 1);
    gradient.endPoint = CGPointMake(0, 0);
    gradient.cornerRadius = props.corner_radius;
    [view.layer addSublayer:gradient];

    UILabel* label = [[UILabel alloc] initWithFrame:CGRectMake(0, 0, width, height)];
    label.text = [NSString stringWithUTF8String:props.title.c_str()];
    label.textColor = [UIColor whiteColor];
    label.font = [UIFont boldSystemFontOfSize:16];
    label.textAlignment = NSTextAlignmentCenter;
    [view addSubview:label];
}
