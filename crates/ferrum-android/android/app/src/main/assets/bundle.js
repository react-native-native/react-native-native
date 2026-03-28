// test_bundle.js — Phase 0 JS test bundle for Project Ferrum.
// Evaluated by ferrum-ios and ferrum-android via Hermes V1 C ABI.

'use strict';

// --- Correctness test ---
var result = rust_add(1, 2);
print(result); // prints "3" as number

if (result !== 3) {
  throw new Error('rust_add returned wrong value');
}

// --- Benchmark: JS → Rust → JS call overhead ---
// Warm up
for (var w = 0; w < 1000; w++) {
  rust_add(w, w);
}

var iterations = 100000;
var start = Date.now();
for (var i = 0; i < iterations; i++) {
  rust_add(i, i);
}
var elapsed = Date.now() - start;
var usPerCall = (elapsed * 1000) / iterations;

// Print numeric values (our print handles numbers)
print(iterations);
print(elapsed);
print(usPerCall);

// Return per-call overhead as the bundle result
usPerCall;
