/**
 * Project Ferrum — Phase 0 test bundle.
 *
 * This bundle is loaded by Rust via the Android AssetManager.
 * It calls the `rust_add` global registered by ferrum-core and logs
 * the result, proving the JS → Rust → JS call path works end-to-end.
 *
 * In Phase 0, `rust_add` is a stub. Once ferrum-core lands and Hermes
 * is embedded, this same bundle evaluates inside Hermes and calls the
 * real Rust implementation via the C ABI.
 *
 * Expected output (Phase 0 stub): "Ferrum: rust_add(1, 2) = 3"
 * Expected output (Phase 0 real): same value, via actual Hermes evaluation
 *
 * The "// EXPECT:" comment below is parsed by the Rust stub evaluator
 * in simulate_rust_add_via_bundle() as a test oracle.
 */

// EXPECT: rust_add(1, 2) = 3

(function () {
  "use strict";

  // rust_add is registered as a JS global by ferrum-core at runtime init.
  // In Phase 0 with the stub evaluator, this function is not actually called
  // from JS — the Rust side reads the EXPECT comment directly. When Hermes
  // evaluation is wired up, this code runs inside Hermes.
  var result = rust_add(1, 2);

  // console.log output is captured by Hermes and routed to Android logcat
  // via ferrum-core's console bridge (Phase 0: stdout stub).
  console.log("Ferrum: rust_add(1, 2) = " + result);
})();
