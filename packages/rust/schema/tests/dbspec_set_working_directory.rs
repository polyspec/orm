//! A set path without a directory, whose root is the working directory (docs/spec/dbspec.md "Document sets"): the working directory
//! is the state of a process, and the trials of a recipe share one process, so no recipe step can state it (FCV-2).
//! Requirements: DBS-12.

use polyspec_orm_schema::dbspec;
use polyspec_orm_test_support::temp_directory;
use std::path::{Path, PathBuf};

/// A directory removed on drop.
struct Tree(PathBuf);

impl Drop for Tree {
    fn drop(&mut self) {
        temp_directory::remove_on_drop(&self.0);
    }
}

#[test]
fn a_set_path_without_a_directory_reads_from_the_working_directory() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let tree = Tree(std::env::temp_dir().join(format!("orm-set-working-directory-{}", std::process::id())));
    std::fs::create_dir(&tree.0).expect("the directory is created");
    std::fs::write(tree.0.join("shop.dbs"), "dbspec 1 shop\n").expect("the document is written");
    std::fs::write(tree.0.join("dbspec-set.json"), r#"{"schema": 1, "documents": ["shop.dbs"]}"#).expect("the set file is written");
    let previous = std::env::current_dir().expect("the working directory is read");
    std::env::set_current_dir(&tree.0).expect("the working directory is set");
    let result = dbspec::read_set(Path::new("dbspec-set.json"));
    std::env::set_current_dir(previous).expect("the working directory is restored");
    let set = result.expect("the set reads");
    assert_eq!(set.documents.iter().map(|f| (f.path.clone(), f.bytes.clone())).collect::<Vec<_>>(), [(PathBuf::from("shop.dbs"), b"dbspec 1 shop\n".to_vec())]);
    assert!(set.external.is_empty());
}
