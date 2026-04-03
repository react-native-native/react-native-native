// platform_info.swift — Swift functions exported to JavaScript.
// Just write normal Swift. The bridge handles @_cdecl and JSON wrapping.

import Foundation
import UIKit

// @nativ_export
func deviceName() -> String {
    return UIDevice.current.name
}

// @nativ_export
func systemVersion() -> String {
    return "iOS " + UIDevice.current.systemVersion
}

// @nativ_export
func batteryLevel() -> Float {
    UIDevice.current.isBatteryMonitoringEnabled = true
    return UIDevice.current.batteryLevel
}
