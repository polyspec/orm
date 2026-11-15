// The private Rust test directory owner (FCV-19). A recipe cannot construct Scratch or observe its Drop lifetime.

use crate::test_support::Scratch;

// Requirements: FCV-19. Repeating a prefix allocates distinct live directories, preserves files of the earlier owner,
// and removes only the directory of the instance that drops.
#[test]
fn scratch_instances_with_the_same_prefix_own_distinct_directories() {
    let _case = polyspec_orm_testcase::case!();
    let first = Scratch::new("orm-scratch-exclusive");
    let first_path = first.path().to_owned();
    let file = first.join("first.bin");
    std::fs::write(&file, b"first owner's file").expect("the first owner creates its file");
    let second = Scratch::new("orm-scratch-exclusive");
    let second_path = second.path().to_owned();
    assert!(file.is_file(), "allocating a second owner must preserve the first owner's file at {}", file.display());
    assert_eq!(std::fs::read(&file).expect("the first file remains readable"), b"first owner's file");
    assert_ne!(first_path, second_path, "live owners with the same prefix must not share a directory");
    let second_file = second.join("second.bin");
    std::fs::write(&second_file, b"second owner's file").expect("the second owner creates its file");
    drop(second);
    assert!(!second_path.exists(), "Drop removes its own directory");
    assert_eq!(std::fs::read(&file).expect("dropping the second owner preserves the first file"), b"first owner's file");
    drop(first);
    assert!(!first_path.exists(), "the first owner removes its own directory");
}
