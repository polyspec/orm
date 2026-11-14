//! The readers of the members of a JSON form, which the JSON forms of the dbspec values and the form of a plan step of
//! polyspec-orm share. A refusal is a text that names the member at `at`.
//! Internal to polyspec-orm: it is not part of the schema crate's API, and nothing outside polyspec-orm may use it.

use serde_json::{Map, Value};

/// The members of the object `value`; a value that is no object and a member outside `allowed` are refused.
#[doc(hidden)]
pub fn object<'v>(value: &'v Value, at: &str, allowed: &[&str]) -> Result<&'v Map<String, Value>, String> {
    let Value::Object(members) = value else { return Err(format!("{at} is no object")) };
    match members.keys().find(|key| !allowed.contains(&key.as_str())) {
        Some(key) => Err(format!("{at}.{key} is no member of the form")),
        None => Ok(members),
    }
}

/// The member `key` of `members`; an absent member is refused.
#[doc(hidden)]
pub fn required<'v>(members: &'v Map<String, Value>, at: &str, key: &str) -> Result<&'v Value, String> {
    members.get(key).ok_or_else(|| format!("{at}.{key} is absent"))
}
