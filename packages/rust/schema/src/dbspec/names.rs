//! The names that the renderer writes (docs/dbspec.md "Names"): the plain form when it has at most 63
//! bytes, otherwise its first 54 bytes, a `$` and the first 8 lowercase hexadecimal digits of its SHA-256.

use super::parser::MAX_NAME_BYTES;
use sha2::{Digest, Sha256};

/// Hexadecimal digits of the hash in a generated name.
const HASH_DIGITS: usize = 8;
/// Bytes of the plain form that a generated name keeps: 54 + `$` + 8 digits = 63.
const PREFIX_BYTES: usize = MAX_NAME_BYTES - 1 - HASH_DIGITS;

/// The name that the renderer writes for the suffix (a column or an event) of `table`.
pub(crate) fn renderer_name(table: &str, suffix: &str) -> String {
    let plain = format!("{table}${suffix}");
    if plain.len() <= MAX_NAME_BYTES {
        return plain;
    }
    let digest = Sha256::digest(plain.as_bytes());
    let hash: String = digest.iter().take(HASH_DIGITS / 2).map(|byte| format!("{byte:02x}")).collect();
    format!("{}${hash}", &plain[..PREFIX_BYTES])
}

/// The column among `columns` whose renderer name is `name`. Each name is recomputed; `name` is never split on `$`.
pub(crate) fn rendered_column<'a>(table: &str, name: &str, columns: impl Iterator<Item = &'a str>) -> Option<&'a str> {
    columns.into_iter().find(|column| renderer_name(table, column) == name)
}
