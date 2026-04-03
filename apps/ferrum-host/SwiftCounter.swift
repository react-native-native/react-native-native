// SwiftCounter.swift — A SwiftUI view rendered inside React Native.
// Just write the view — the bridge handles everything else.

import SwiftUI

// @nativ_component
struct SwiftCounterView: View {
    let title: String
    let color: Color

    var body: some View {
        VStack(spacing: 8) {
            Text(title)
                .font(.system(size: 18, weight: .bold))
                .foregroundColor(.white)
            Text("SwiftUI inside React Native")
                .font(.system(size: 11))
                .foregroundColor(.white.opacity(0.7))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(color)
    }
}
