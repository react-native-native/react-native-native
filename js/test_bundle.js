// test_bundle.js — Phase 0 JS test bundle for Project Ferrum.
//
// Evaluated by ferrum-ios and ferrum-android via Hermes V1 C ABI.
// Calls rust_add (registered by ferrum-core) and benchmarks call overhead.

'use strict';

// --- Correctness test ---
var result = rust_add(1, 2);
print('rust_add(1, 2) = ' + result);

if (result !== 3) {
  throw new Error('rust_add returned ' + result + ', expected 3');
}

// --- Benchmark: JS → Rust → JS call overhead ---
// Warm up the JIT / inline caches
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
print('Benchmark: ' + iterations + ' calls in ' + elapsed + 'ms');
print('Per-call overhead: ' + usPerCall.toFixed(2) + ' us');

if (usPerCall > 50) {
  print('WARNING: call overhead ' + usPerCall.toFixed(2) + ' us EXCEEDS 50us gate!');
} else {
  print('PASS: call overhead ' + usPerCall.toFixed(2) + ' us is within 50us gate');
}

// Return the result
result;
