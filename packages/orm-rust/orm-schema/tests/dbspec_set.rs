//! The set reader vectors (tests/dbspec/set-files.json, docs/dbspec.md "Document sets").
//!
//! Each case builds its file tree with real directories, files, symbolic links and hard links in a
//! fresh temporary directory and calls `dbspec::read_set` with the tree root joined with `set`.
//! The vector file is read strictly: an unknown or missing field fails the test, and every case
//! runs.

use polyspec_orm_case_clock::CaseClock;
use polyspec_orm_schema::dbspec;
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

const CASE_DEADLINE: Duration = Duration::from_secs(1);
// SUITE_DEADLINE is the CPU time limit of the test; the wall-clock deadline that ends a stuck test is
// ten times it (polyspec_orm_testcase::wall_for_cpu).
const SUITE_DEADLINE: Duration = Duration::from_secs(5);

fn vectors_path() -> PathBuf {
    polyspec_orm_testcase::manifest_dir().join("../../../tests/dbspec/set-files.json")
}

/// The object `value` with exactly the keys `required` and any of `optional`, or a panic naming `what`.
fn object<'a>(value: &'a Value, what: &str, required: &[&str], optional: &[&str]) -> &'a Map<String, Value> {
    let map = value.as_object().unwrap_or_else(|| panic!("{what}: not an object"));
    for key in map.keys() {
        assert!(required.contains(&key.as_str()) || optional.contains(&key.as_str()), "{what}: unknown field {key:?}");
    }
    for key in required {
        assert!(map.contains_key(*key), "{what}: missing field {key:?}");
    }
    map
}

fn string<'a>(value: &'a Value, what: &str) -> &'a str {
    value.as_str().unwrap_or_else(|| panic!("{what}: not a string"))
}

fn strings(value: &Value, what: &str) -> Vec<String> {
    value.as_array().unwrap_or_else(|| panic!("{what}: not an array")).iter().map(|v| string(v, what).to_owned()).collect()
}

fn hex(text: &str, what: &str) -> Vec<u8> {
    assert!(text.len().is_multiple_of(2), "{what}: odd hex length");
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap_or_else(|e| panic!("{what}: {e}"))).collect()
}

/// A fresh empty directory under the system temporary directory, removed on drop.
struct Tree(PathBuf);

impl Tree {
    fn new(id: &str) -> Tree {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!("orm-set-{}-{}-{id}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir(&dir).unwrap_or_else(|e| panic!("{}: {e}", dir.display()));
        Tree(dir)
    }
}

impl Drop for Tree {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn parent_dirs(path: &Path) {
    let parent = path.parent().expect("a tree path has a parent");
    std::fs::create_dir_all(parent).unwrap_or_else(|e| panic!("{}: {e}", parent.display()));
}

#[cfg(unix)]
fn symlink(target: &str, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(windows)]
fn symlink(target: &str, link: &Path) -> std::io::Result<()> {
    // Windows distinguishes file and directory links; the tree's targets exist when links are made.
    let resolved = link.parent().expect("a link has a parent").join(target);
    if std::fs::metadata(&resolved).map(|m| m.is_dir()).unwrap_or(false) {
        std::os::windows::fs::symlink_dir(target, link)
    } else {
        std::os::windows::fs::symlink_file(target, link)
    }
}

/// Builds the case tree: files first, then hard links, then symbolic links, so that the order of the
/// JSON object does not matter.
fn build(root: &Path, tree: &Map<String, Value>, id: &str) {
    let mut links = Vec::new();
    let mut hardlinks = Vec::new();
    for (name, entry) in tree {
        let what = format!("{id}: tree {name:?}");
        let entry = entry.as_object().unwrap_or_else(|| panic!("{what}: not an object"));
        assert_eq!(entry.len(), 1, "{what}: exactly one of file, hex, symlink, hardlink");
        let (kind, value) = entry.iter().next().unwrap();
        let path = root.join(name);
        match kind.as_str() {
            "file" | "hex" => {
                let bytes = if kind == "file" { string(value, &what).as_bytes().to_vec() } else { hex(string(value, &what), &what) };
                parent_dirs(&path);
                std::fs::write(&path, bytes).unwrap_or_else(|e| panic!("{what}: {e}"));
            }
            "hardlink" => hardlinks.push((path, root.join(string(value, &what)), what)),
            "symlink" => links.push((path, string(value, &what).to_owned(), what)),
            other => panic!("{what}: unknown field {other:?}"),
        }
    }
    for (path, original, what) in hardlinks {
        parent_dirs(&path);
        std::fs::hard_link(&original, &path).unwrap_or_else(|e| panic!("{what}: {e}"));
    }
    for (path, target, what) in links {
        parent_dirs(&path);
        symlink(&target, &path).unwrap_or_else(|e| panic!("{what}: {e}"));
    }
}

fn run(case: &Value) {
    let map = object(case, "case", &["id", "tree", "set", "want"], &[]);
    let id = string(&map["id"], "case id");
    let inner = polyspec_orm_testcase::start(format!("set-files/{id}"), polyspec_orm_testcase::wall_for_cpu(CASE_DEADLINE));
    let clock = CaseClock::start();
    let tree = map["tree"].as_object().unwrap_or_else(|| panic!("{id}: tree is not an object"));
    let set = string(&map["set"], id);
    let dir = Tree::new(id);
    build(&dir.0, tree, id);
    let root = dir.0.display().to_string();
    let joined = |relative: &str| format!("{root}/{relative}");
    let got = dbspec::read_set(&dir.0.join(set));
    let want = map["want"].as_object().unwrap_or_else(|| panic!("{id}: want is not an object"));
    if want.contains_key("errors") {
        let want = object(&map["want"], &format!("{id}: want"), &["errors"], &[]);
        let expected: Vec<(String, String)> = want["errors"]
            .as_array()
            .unwrap_or_else(|| panic!("{id}: errors is not an array"))
            .iter()
            .map(|e| {
                let e = object(e, &format!("{id}: error"), &["rule", "path"], &[]);
                (string(&e["rule"], id).to_owned(), joined(string(&e["path"], id)))
            })
            .collect();
        match got {
            Ok(set) => panic!("{id}: read a set where errors are expected: documents {:?}", set.documents.iter().map(|f| &f.path).collect::<Vec<_>>()),
            Err(errors) => {
                let actual: Vec<(String, String)> = errors.iter().map(|e| (e.rule.clone(), e.path.display().to_string())).collect();
                assert_eq!(actual, expected, "{id}: errors {errors:?}");
                for error in &errors {
                    assert!(!error.message.is_empty(), "{id}: an error has a message");
                }
            }
        }
    } else {
        let want = object(&map["want"], &format!("{id}: want"), &["documents", "external"], &[]);
        let set = got.unwrap_or_else(|errors| panic!("{id}: unexpected errors {errors:?}"));
        for (list, files) in [("documents", &set.documents), ("external", &set.external)] {
            let expected: Vec<String> = strings(&want[list], id).iter().map(|p| joined(p)).collect();
            let actual: Vec<String> = files.iter().map(|f| f.path.display().to_string()).collect();
            assert_eq!(actual, expected, "{id}: {list}");
            for file in files {
                let bytes = std::fs::read(&file.path).unwrap_or_else(|e| panic!("{id}: {}: {e}", file.path.display()));
                assert_eq!(file.bytes, bytes, "{id}: the bytes of {}", file.path.display());
            }
        }
    }
    let (cpu, wall) = (clock.cpu(), clock.wall());
    if cpu >= CASE_DEADLINE {
        polyspec_orm_testcase::warning(format_args!("{id}: cpu {cpu:?} exceeds {CASE_DEADLINE:?} (wall {wall:?})"));
    }
    drop(inner);
}

/// Every case of set-files.json gives its documents and external files, or its errors in order.
#[test]
fn shared_set_file_vectors() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::wall_for_cpu(SUITE_DEADLINE));
    let clock = CaseClock::start();
    let path = vectors_path();
    let file: Value = serde_json::from_slice(&std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))).unwrap();
    let file = object(&file, "set-files.json", &["version", "note", "cases"], &[]);
    assert_eq!(file["version"], 1, "set-files.json version");
    string(&file["note"], "note");
    let cases = file["cases"].as_array().expect("cases are listed");
    assert!(!cases.is_empty(), "cases are not empty");
    for case in cases {
        run(case);
    }
    polyspec_orm_testcase::step(format_args!("{} set file cases", cases.len()));
    let cpu = clock.cpu();
    assert!(cpu < SUITE_DEADLINE, "set file vectors took cpu {cpu:?}");
}
