//! The row of a test model: a struct with its core and its column values, and the `Model` impl that reads and writes
//! the values by the column names of the entity (KSTD-5-46).

/// Defines the row `$row` of the entity `$entity`, whose column names are the constant `$columns`, with its `Model` impl.
macro_rules! model_row {
    ($row:ident, $entity:ident, $columns:ident) => {
        #[derive(Clone)]
        pub struct $row {
            pub core: polyspec_orm::Core,
            pub values: std::collections::BTreeMap<String, polyspec_orm::Val>,
        }

        impl polyspec_orm::Model for $row {
            fn entity() -> &'static polyspec_orm::Entity {
                &$entity
            }
            fn core(&self) -> &polyspec_orm::Core {
                &self.core
            }
            fn core_mut(&mut self) -> &mut polyspec_orm::Core {
                &mut self.core
            }
            fn from_core(core: polyspec_orm::Core) -> Self {
                $row { core, values: std::collections::BTreeMap::new() }
            }
            fn into_core(self) -> polyspec_orm::Core {
                self.core
            }
            fn assign(&mut self, name: &str, v: polyspec_orm::Val) -> polyspec_orm::Result<bool> {
                if !$columns.contains(&name) {
                    return Ok(false);
                }
                self.values.insert(name.to_owned(), v);
                Ok(true)
            }
            fn value(&self, name: &str) -> Option<polyspec_orm::Val> {
                self.values.get(name).cloned()
            }
        }
    };
}
