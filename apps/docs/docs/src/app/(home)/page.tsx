import Link from 'next/link';
import Image from 'next/image';

const languages = [
  {
    name: 'Rust',
    icon: '🦀',
    snippet: `use rna_core::prelude::*;

#[component]
pub struct HelloRust {
    text: String,
    r: f64,
    g: f64,
    b: f64,
    on_press: Callback,
}

impl NativeView for HelloRust {
    fn mount(&mut self, view: NativeViewHandle) {
        view.set_background_color(self.r, self.g, self.b, 1.0);
        view.add_label(&self.text, 0.5, 1.0, 0.0);
    }
}`,
  },
  {
    name: 'C++',
    icon: '⚡',
    snippet: `#include <cmath>
#include <string>

RNA_EXPORT(sync)
int add(int a, int b) {
    return a + b;
}

RNA_EXPORT(sync)
double fast_inv_sqrt(double x) {
    float xf = static_cast<float>(x);
    float xhalf = 0.5f * xf;
    int i = *(int*)&xf;
    i = 0x5f3759df - (i >> 1);
    xf = *(float*)&i;
    xf = xf * (1.5f - xhalf * xf * xf);
    return static_cast<double>(xf);
}`,
  },
  {
    name: 'ObjC++',
    icon: '📱',
    snippet: `#import <UIKit/UIKit.h>
#include <string>

RNA_EXPORT(sync)
std::string getColorScheme() {
    UITraitCollection *traits =
        [UITraitCollection currentTraitCollection];
    switch (traits.userInterfaceStyle) {
        case UIUserInterfaceStyleDark:  return "dark";
        case UIUserInterfaceStyleLight: return "light";
        default: return "unknown";
    }
}`,
  },
  {
    name: 'Kotlin / Compose',
    icon: '🟣',
    snippet: `// @rna_component
@Composable
fun ComposeCard(title: String) {
    var count by remember { mutableIntStateOf(0) }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFC6A1B9A)),
        contentAlignment = Alignment.Center
    ) {
        Text(text = title, color = Color.White,
             fontSize = 18.sp,
             fontWeight = FontWeight.Bold)
    }
}`,
  },
  {
    name: 'Swift / SwiftUI',
    icon: '🍎',
    snippet: `import SwiftUI

// @rna_component
struct SwiftCounterView: View {
    let title: String
    let color: Color

    var body: some View {
        VStack(spacing: 8) {
            Text(title)
                .font(.system(size: 18, weight: .bold))
                .foregroundColor(.white)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(color)
    }
}`,
  },
  {
    name: 'Zig',
    icon: '⚙️',
    snippet: `const std = @import("std");

export fn add(a: i32, b: i32) i32 {
    return a + b;
}

export fn fibonacci(n: u32) u64 {
    var a: u64 = 0;
    var b: u64 = 1;
    for (0..n) |_| {
        const tmp = a + b;
        a = b;
        b = tmp;
    }
    return a;
}`,
  },
];

const jsSnippet = `// App.tsx — native files import like any other module
import HelloRust from './HelloRust';
import { add, greet } from './math_utils';
import { getColorScheme } from './device_info';
import { tapMedium } from './haptics';
import ComposeCard from './ComposeCard';
import SwiftCounter from './SwiftCounter';

export default function App() {
  return (
    <View>
      <HelloRust text="From JS!" r={0.2} g={0.9} b={0.9} />
      <ComposeCard title="Hello Compose!" />
      <SwiftCounter title="SwiftUI!" r={0.9} g={0.5} b={0.9} />
      <Text>{greet("world")}</Text>
      <Text>{getColorScheme()}</Text>
      <Pressable onPress={() => tapMedium()}>
        <Text>Haptic</Text>
      </Pressable>
    </View>
  );
}`;

export default function HomePage() {
  return (
    <main className="flex flex-col items-center">
      {/* Hero */}
      <section className="flex flex-col items-center text-center px-6 pt-20 pb-16 max-w-4xl">
        <Image
          src="/logo.png"
          alt="React Native Native"
          width={180}
          height={180}
          className="mb-8"
          priority
        />
        <h1 className="text-5xl font-bold tracking-tight mb-4">
          React Native Native
        </h1>
        <p className="text-xl text-fd-muted-foreground max-w-2xl mb-8">
          Drop a <strong>.rs</strong>, <strong>.cpp</strong>,{' '}
          <strong>.mm</strong>, <strong>.kt</strong>, <strong>.swift</strong>,
          or <strong>.zig</strong> file right next to your JS components. It
          compiles on save, hot-reloads to your device, and just works — no
          Xcode, no Android Studio.
        </p>
        <div className="flex gap-4">
          <Link
            href="/docs"
            className="px-6 py-3 rounded-lg bg-fd-primary text-fd-primary-foreground font-medium hover:opacity-90 transition-opacity"
          >
            Get Started
          </Link>
          <Link
            href="https://github.com/react-native-native/react-native-native"
            className="px-6 py-3 rounded-lg border border-fd-border font-medium hover:bg-fd-accent transition-colors"
          >
            GitHub
          </Link>
        </div>
      </section>

      {/* JS import example */}
      <section className="px-6 py-16 max-w-4xl w-full">
        <h2 className="text-3xl font-bold text-center mb-4">
          Native code lives next to your JS
        </h2>
        <p className="text-lg text-fd-muted-foreground text-center mb-8">
          Import native files like any other module. No separate project, no
          context switching.
        </p>
        <pre className="text-sm bg-fd-secondary rounded-xl p-6 overflow-x-auto">
          <code>{jsSnippet}</code>
        </pre>
      </section>

      {/* Language cards */}
      <section className="px-6 py-16 max-w-[90rem] w-full">
        <h2 className="text-3xl font-bold text-center mb-12">
          Pick your language
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {languages.map((lang) => (
            <div
              key={lang.name}
              className="rounded-xl border border-fd-border bg-fd-card p-6 hover:border-fd-primary/50 transition-colors"
            >
              <div className="flex items-center gap-2 mb-4">
                <span className="text-2xl">{lang.icon}</span>
                <h3 className="text-xl font-semibold">{lang.name}</h3>
              </div>
              <pre className="text-sm bg-fd-secondary rounded-lg p-4 overflow-x-auto">
                <code>{lang.snippet}</code>
              </pre>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section className="px-6 py-16 max-w-3xl">
        <h2 className="text-3xl font-bold text-center mb-12">How it works</h2>
        <div className="space-y-8">
          {[
            {
              step: '1',
              title: 'Write native code',
              desc: 'Create a .rs, .cpp, .mm, .kt, .swift, or .zig file right next to your JS components. Same project, same folder.',
            },
            {
              step: '2',
              title: 'Save',
              desc: 'Metro detects the change, compiles your native code, and code-signs it automatically.',
            },
            {
              step: '3',
              title: 'See it on device',
              desc: 'Your component hot-reloads on the physical device. Sub-second feedback loop, just like JS.',
            },
          ].map((item) => (
            <div key={item.step} className="flex gap-4">
              <div className="flex-shrink-0 w-10 h-10 rounded-full bg-fd-primary text-fd-primary-foreground flex items-center justify-center font-bold">
                {item.step}
              </div>
              <div>
                <h3 className="text-lg font-semibold">{item.title}</h3>
                <p className="text-fd-muted-foreground">{item.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="px-6 py-20 text-center">
        <h2 className="text-3xl font-bold mb-4">Ready to go native?</h2>
        <p className="text-lg text-fd-muted-foreground mb-8">
          Get started in under 5 minutes.
        </p>
        <Link
          href="/docs"
          className="px-8 py-4 rounded-lg bg-fd-primary text-fd-primary-foreground font-medium text-lg hover:opacity-90 transition-opacity"
        >
          Read the docs
        </Link>
      </section>
    </main>
  );
}
