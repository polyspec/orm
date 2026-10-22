//! The typed model of a test table: one struct per table with its columns by name, and the Model methods that read
//! and write them. Each column type says how a value is read from a Val and written to one; a column with no value to
//! write (`to_val` returns None) is not read back by name.

use std::sync::LazyLock;

use chrono::NaiveDateTime;
use polyspec_orm::{Entity, Val};

/// A column type: `from_val` reads a value written to the column, `to_val` gives the value read back by name.
pub trait Column: Default {
    fn from_val(v: Val) -> polyspec_orm::Result<Self>;
    fn to_val(&self) -> Option<Val>;
}

impl Column for i64 {
    fn from_val(v: Val) -> polyspec_orm::Result<Self> {
        v.as_i64()
    }
    fn to_val(&self) -> Option<Val> {
        Some(Val::I64(*self))
    }
}

impl Column for String {
    fn from_val(v: Val) -> polyspec_orm::Result<Self> {
        v.as_string()
    }
    fn to_val(&self) -> Option<Val> {
        Some(Val::Str(self.clone()))
    }
}

impl Column for NaiveDateTime {
    fn from_val(v: Val) -> polyspec_orm::Result<Self> {
        v.as_datetime()
    }
    fn to_val(&self) -> Option<Val> {
        Some(Val::DateTime(*self))
    }
}

impl Column for Option<NaiveDateTime> {
    fn from_val(v: Val) -> polyspec_orm::Result<Self> {
        if v.is_null() {
            Ok(None)
        } else {
            Ok(Some(v.as_datetime()?))
        }
    }
    fn to_val(&self) -> Option<Val> {
        Some(match self {
            None => Val::Null,
            Some(x) => Val::DateTime(*x),
        })
    }
}

impl Column for Option<Val> {
    fn from_val(v: Val) -> polyspec_orm::Result<Self> {
        Ok(Some(v))
    }
    fn to_val(&self) -> Option<Val> {
        None
    }
}

/// The entity of a table, declared as a static `Entity` or as a `LazyLock<Entity>` when its schema is built at run time.
pub trait EntityRef {
    fn entity(&'static self) -> &'static Entity;
}

impl EntityRef for Entity {
    fn entity(&'static self) -> &'static Entity {
        self
    }
}

impl EntityRef for LazyLock<Entity> {
    fn entity(&'static self) -> &'static Entity {
        self
    }
}

/// Declares the struct `$name` with one field per column, each column given by its name and its type; the entity
/// `$entity` is declared by the test file and read through `EntityRef`.
macro_rules! typed_model {
    ($name:ident, $entity:ident, { $($field:ident : $ty:ty = $column:literal),* $(,)? }) => {
        #[derive(Clone)]
        pub struct $name {
            pub core: polyspec_orm::Core,
            $(pub $field: $ty),*
        }

        impl polyspec_orm::Model for $name {
            fn entity() -> &'static polyspec_orm::Entity {
                crate::typed_model::EntityRef::entity(&$entity)
            }
            fn core(&self) -> &polyspec_orm::Core {
                &self.core
            }
            fn core_mut(&mut self) -> &mut polyspec_orm::Core {
                &mut self.core
            }
            fn from_core(core: polyspec_orm::Core) -> Self {
                $name { core, $($field: Default::default()),* }
            }
            fn into_core(self) -> polyspec_orm::Core {
                self.core
            }
            fn assign(&mut self, name: &str, v: polyspec_orm::Val) -> polyspec_orm::Result<bool> {
                match name {
                    $($column => self.$field = <$ty as crate::typed_model::Column>::from_val(v)?,)*
                    _ => return Ok(false),
                }
                Ok(true)
            }
            fn value(&self, name: &str) -> Option<polyspec_orm::Val> {
                match name {
                    $($column => <$ty as crate::typed_model::Column>::to_val(&self.$field),)*
                    _ => None,
                }
            }
        }
    };
}
