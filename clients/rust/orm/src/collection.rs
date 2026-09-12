//! Ordered map keyed by PK (or key_by), and the paginate result.

use indexmap::IndexMap;

use crate::value::Val;

/// Collection key: an integer or a string, whichever the key column yields.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Key {
    I(i64),
    S(String),
}

impl Key {
    pub fn of(v: &Val) -> Key {
        match v {
            Val::I64(x) => Key::I(*x),
            other => Key::S(other.as_string()),
        }
    }

    pub fn of_row(row: &[Val], refs: &[crate::plan::KeyRef]) -> Option<Key> {
        if refs.len() == 1 {
            let value = &row[refs[0].index];
            return (!value.is_null()).then(|| Key::of(value));
        }
        let mut out = String::new();
        for reference in refs {
            let value = &row[reference.index];
            if value.is_null() { return None; }
            let part = value.as_string();
            out.push_str(&format!("{}:{}", part.len(), part));
        }
        Some(Key::S(out))
    }

    pub fn as_i64(&self) -> i64 {
        match self {
            Key::I(x) => *x,
            Key::S(s) => s.parse().unwrap_or(0),
        }
    }
}

impl std::fmt::Display for Key {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Key::I(x) => write!(f, "{x}"),
            Key::S(s) => write!(f, "{s}"),
        }
    }
}

/// Never null from a terminal: `gets()` on no rows returns an empty collection.
#[derive(Debug, Clone)]
pub struct Collection<T> {
    items: IndexMap<Key, T>,
}

pub trait RowExport {
    fn to_map(&self) -> crate::Result<serde_json::Value>;
}

impl<T: RowExport> Collection<T> {
    pub fn to_map(&self) -> crate::Result<serde_json::Value> {
        let mut out = serde_json::Map::new();
        for (key,row) in self.iter() {
            let key=key.to_string();
            if out.contains_key(&key) { return Err(crate::Error::Engine { code:"IR_INVALID".into(), msg:"array conversion loses key type; use entries".into() }); }
            out.insert(key,row.to_map()?);
        }
        Ok(serde_json::Value::Object(out))
    }
}

impl<T> Default for Collection<T> {
    fn default() -> Self {
        Collection { items: IndexMap::new() }
    }
}

impl<T> Collection<T> {
    pub fn with_capacity(n: usize) -> Self {
        Collection { items: IndexMap::with_capacity(n) }
    }

    pub fn put(&mut self, k: Key, v: T) {
        self.items.insert(k, v);
    }

    pub fn get(&self, k: &Key) -> Option<&T> {
        self.items.get(k)
    }

    pub fn get_mut(&mut self, k: &Key) -> Option<&mut T> { self.items.get_mut(k) }

    pub fn keys(&self) -> impl Iterator<Item = &Key> { self.items.keys() }

    pub fn entries(&self) -> impl Iterator<Item = (&Key, &T)> { self.items.iter() }

    pub fn first(&self) -> Option<&T> {
        self.items.values().next()
    }

    pub fn first_mut(&mut self) -> Option<&mut T> { self.items.values_mut().next() }

    pub fn iter_mut(&mut self) -> impl Iterator<Item = (&Key, &mut T)> { self.items.iter_mut() }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = (&Key, &T)> {
        self.items.iter()
    }

    pub fn to_vec(self) -> Vec<T> {
        self.items.into_values().collect()
    }
}

impl<'a, T> IntoIterator for &'a Collection<T> {
    type Item = (&'a Key, &'a T);
    type IntoIter = indexmap::map::Iter<'a, Key, T>;
    fn into_iter(self) -> Self::IntoIter {
        self.items.iter()
    }
}

#[derive(Debug, Clone)]
pub struct Page<T> {
    pub items: Collection<T>,
    pub total: i64,
    pub pages: i64,
    pub current: i64,
    pub per: i64,
}
