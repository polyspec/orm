//! The typed content of the gathered language classes that preserve ambiguous value kinds (CORE-124).

use binding_core::OrderedMap;

use super::OrmValue;

/// An `int` whose native integer representation would otherwise reenter as `int64`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IntegerValue(i64);

impl IntegerValue {
    /// Keeps the signed integer without changing its kind to `int64`.
    #[must_use]
    pub const fn new(value: i64) -> Self {
        Self(value)
    }

    /// The native signed integer held by the class.
    #[must_use]
    pub const fn value(&self) -> i64 {
        self.0
    }
}

/// A `float` whose integral native number would otherwise reenter as `int`.
#[derive(Debug, Clone, PartialEq)]
pub struct FloatValue(f64);

impl FloatValue {
    /// Keeps the float and its signed zero; alias input validates whether it is finite.
    #[must_use]
    pub const fn new(value: f64) -> Self {
        Self(value)
    }

    /// The native float held by the class.
    #[must_use]
    pub const fn value(&self) -> f64 {
        self.0
    }
}

/// Bytes whose UTF-8 content would otherwise reenter as PHP text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BytesValue(Vec<u8>);

impl BytesValue {
    /// Keeps every byte, including empty and valid UTF-8 content.
    #[must_use]
    pub fn new(value: Vec<u8>) -> Self {
        Self(value)
    }

    /// A native copy of the held bytes, so reading does not change the class.
    #[must_use]
    pub fn value(&self) -> Vec<u8> {
        self.0.clone()
    }
}

/// A map whose PHP array representation would otherwise reenter as a list.
#[derive(Debug, Clone, PartialEq)]
pub struct MapValue(OrderedMap<OrmValue>);

impl MapValue {
    /// Keeps the text keys in their insertion order, independently of their numeric shape.
    #[must_use]
    pub fn new(entries: OrderedMap<OrmValue>) -> Self {
        Self(entries)
    }

    /// A native copy of the entries, retaining the order and the kinds of their values.
    #[must_use]
    pub fn entries(&self) -> OrderedMap<OrmValue> {
        self.0.clone()
    }
}
