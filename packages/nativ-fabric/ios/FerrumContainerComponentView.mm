// FerrumContainerComponentView — Fabric component that hosts native views
// rendered by Rust/C++/Swift/ObjC++ via react-native-anywhere.
//
// Uses self.contentView (RCTViewComponentView built-in) to isolate our
// rendering from Fabric's own view management. Fabric manages `self`,
// we manage `_contentView`. No background color conflicts.

#import <React/RCTViewComponentView.h>
#import <React/RCTComponentViewFactory.h>

#include "react/renderer/components/FerrumFabricSpec/ComponentDescriptors.h"
#include "react/renderer/components/FerrumFabricSpec/EventEmitters.h"
#include "react/renderer/components/FerrumFabricSpec/Props.h"
#include "react/renderer/components/FerrumFabricSpec/RCTComponentViewHelpers.h"

#import "FerrumCppRuntime.h"

using namespace facebook::react;

@interface FerrumContainerComponentView : RCTViewComponentView
@end

@implementation FerrumContainerComponentView {
  UIView *_contentView;
  std::string _componentId;
  std::string _propsJson;
  BOOL _mounted;
  CGSize _lastRenderedSize;
}

+ (void)load {
  dispatch_async(dispatch_get_main_queue(), ^{
    [[RCTComponentViewFactory currentComponentViewFactory]
        registerComponentViewClass:FerrumContainerComponentView.class];
  });
}

+ (ComponentDescriptorProvider)componentDescriptorProvider {
  return concreteComponentDescriptorProvider<FerrumContainerComponentDescriptor>();
}

- (instancetype)initWithFrame:(CGRect)frame {
  if (self = [super initWithFrame:frame]) {
    static const auto defaultProps = std::make_shared<const FerrumContainerProps>();
    _props = defaultProps;

    _contentView = [[UIView alloc] init];
    _contentView.clipsToBounds = YES;
    self.contentView = _contentView;

    _mounted = NO;
  }
  return self;
}

- (void)updateProps:(const Props::Shared &)props
           oldProps:(const Props::Shared &)oldProps {
  auto const &newProps = *std::static_pointer_cast<FerrumContainerProps const>(props);

  bool componentChanged = (_componentId != newProps.componentId);
  bool propsChanged = (_propsJson != newProps.propsJson);

  _componentId = newProps.componentId;
  _propsJson = newProps.propsJson;

  if (componentChanged) {
    _mounted = NO;
  }

  [super updateProps:props oldProps:oldProps];

  if ((componentChanged || propsChanged) && !_componentId.empty()) {
    CGSize size = _contentView.bounds.size;
    if (!_mounted && size.width > 0 && size.height > 0) {
      [self _fullRender];
    } else if (_mounted) {
      [self _updateRender];
    }
  }
}

- (void)layoutSubviews {
  [super layoutSubviews];

  // Sync contentView frame to self
  _contentView.frame = self.bounds;

  CGSize size = _contentView.bounds.size;
  if (!_componentId.empty() && size.width > 0 && size.height > 0) {
    if (!_mounted) {
      _lastRenderedSize = size;
      [self _fullRender];
    } else if (!CGSizeEqualToSize(size, _lastRenderedSize)) {
      _lastRenderedSize = size;
      [self _updateRender];
    }
  }
}

- (void)_fullRender {
  [self _clearContentView];
  extern const char* ferrum_try_render(const char*, void*, float, float);
  const char* result = ferrum_try_render(
    _componentId.c_str(), (__bridge void*)_contentView,
    _contentView.bounds.size.width, _contentView.bounds.size.height);
  if (result) {
    _mounted = YES;
  }
}

- (void)_updateRender {
  [self _clearContentView];
  extern const char* ferrum_try_render(const char*, void*, float, float);
  ferrum_try_render(
    _componentId.c_str(), (__bridge void*)_contentView,
    _contentView.bounds.size.width, _contentView.bounds.size.height);
}

- (void)_clearContentView {
  for (UIView *sub in [_contentView.subviews copy]) {
    [sub removeFromSuperview];
  }
  for (CALayer *sub in [_contentView.layer.sublayers copy]) {
    [sub removeFromSuperlayer];
  }
}

- (void)prepareForRecycle {
  [super prepareForRecycle];
  _componentId.clear();
  _propsJson.clear();
  _mounted = NO;
  _lastRenderedSize = CGSizeZero;
  [self _clearContentView];
}

@end
