//! `ferrum-core` — shared Hermes runtime initialization for Project Ferrum.
//!
//! This crate is the single dependency that both `ferrum-ios` and
//! `ferrum-android` pull in. It hides the `hermes-abi-rs` details behind a
//! simpler `FerumRuntime` API and pre-registers Phase 0 built-ins.

pub mod bootstrap;
pub mod bridge;

// Re-export the most commonly needed types so platform crates only need one
// import.
pub use bootstrap::FerumRuntime;
pub use hermes_abi_rs::error::{HermesError, Result};
pub use hermes_abi_rs::value::Value;
