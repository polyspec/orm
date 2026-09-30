//! Exact physical names, separate from logical model identifier rules.
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IdentityError;
impl fmt::Display for IdentityError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SCHEMA_INVALID")
    }
}
impl std::error::Error for IdentityError {}

#[derive(Clone, PartialEq, Eq)]
pub struct PhysicalIdentity {
    parts: [Option<String>; 4],
    key: String,
}
impl fmt::Debug for PhysicalIdentity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PhysicalIdentity")
    }
}
impl PhysicalIdentity {
    pub fn new(catalog: Option<String>, schema: Option<String>, table: String, column: Option<String>) -> Result<Self, IdentityError> {
        let parts = [catalog, schema, Some(table), column];
        for value in parts.iter().flatten() {
            if value.is_empty() || value.len() > 1024 || value.bytes().any(|b| b < 32 || b == 127) {
                return Err(IdentityError);
            }
        }
        let tokens = parts
            .iter()
            .map(|part| match part {
                None => "-".to_owned(),
                Some(part) => part.as_bytes().iter().map(|byte| format!("{byte:02x}")).collect(),
            })
            .collect::<Vec<String>>();
        Ok(Self { parts, key: format!("p1:{}", tokens.join(".")) })
    }
    pub fn key(&self) -> &str {
        &self.key
    }
    pub fn parts(&self) -> [Option<&str>; 4] {
        self.parts.each_ref().map(|part| part.as_deref())
    }
}
