//! The refused TLS options, contracts/fixtures/dsn_reject/dsn_reject_checked.json, without a database
//! (docs/spec/feature-coverage.md FCV-3).
//! Requirements: CFG-18, CFG-36, INT-187.
//!
//! Rust runs the TLS cases of the recipe. Its configuration holds `pool_size`, `pool_idle_size`, `pool_lifetime_ms` and
//! `statement_timeout_ms` in `u32`, so the cases that pass a negative value have no call in Rust (CFG-36): the native test
//! `statement_timeout_negative_is_unrepresentable` holds that refusal.

use polyspec_orm_tests::recipe;

/// The cases of contracts/fixtures/dsn_reject/dsn_reject_checked.json that Rust's types can represent.
const CASES: &[&str] = &[
    "tls_mode_verify_ca",
    "tls_mode_required",
    "tls_mode_preferred",
    "tls_mode_disabled",
    "tls_mode_lower_case",
    "tls_mode_empty",
    "tls_mode_without_ca",
    "tls_relative_ca",
    "tls_ca_without_mode",
    "tls_unreadable_ca",
];

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    recipe::trials_of_cases("dsn_reject_checked_none", "contracts/fixtures/dsn_reject/dsn_reject_checked.json", recipe::NONE, CASES)
}
