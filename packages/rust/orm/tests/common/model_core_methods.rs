//! Shared core-access methods for the Rust ORM test models.

macro_rules! model_core_methods {
    ($entity:expr, $construct:expr) => {
        fn entity() -> &'static polyspec_orm::Entity {
            $entity
        }
        fn core(&self) -> &polyspec_orm::Core {
            &self.core
        }
        fn core_mut(&mut self) -> &mut polyspec_orm::Core {
            &mut self.core
        }
        fn from_core(core: polyspec_orm::Core) -> Self {
            ($construct)(core)
        }
        fn into_core(self) -> polyspec_orm::Core {
            self.core
        }
    };
}
