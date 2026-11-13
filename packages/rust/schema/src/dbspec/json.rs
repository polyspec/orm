//! The JSON forms of the dbspec values (docs/spec/flowmark-surface.md FMS-10 to FMS-16, FMS-80): a column type, a
//! document, the entities of a runtime model, a diagnostic and a declaration position, as the schemas of
//! `contracts/interface/flowmark/dbspec.schema.json` state them. The module holds no function yet: the cases of
//! FMS-81 below are written first and do not compile.

#[cfg(test)]
#[path = "../../tests/unit/flowmark_surface.rs"]
mod flowmark_surface_tests;
