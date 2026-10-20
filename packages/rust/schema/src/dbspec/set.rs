//! The set reader (`docs/spec/dbspec.md`, "Document sets"). A document set is declared once, in the set
//! file `dbspec-set.json`, and every tool that takes a set reads it with [`read_set`].
//!
//! The reader checks, in this order: the set file and its root (step 1), the JSON (step 2), each
//! listed path in its normal form and each of its components without following a symbolic link
//! (step 3), and the read of each file with its identity from the same handle (step 4). Steps 1
//! and 2 stop at their first error; steps 3 and 4 report each path that breaks them.

use serde::de::{self, MapAccess, SeqAccess, Visitor};
use serde::Deserializer as _;
use serde_json::value::RawValue;
use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::fmt;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

/// The name of every set file.
pub const SET_FILE_NAME: &str = "dbspec-set.json";

/// The set file is misnamed, a file is missing, unreadable or not regular, a component is not a
/// directory, or a segment is not a name that its directory lists.
pub const RULE_SET_FILE: &str = "set.file";
/// The set file, the root or an examined component is a symbolic link.
pub const RULE_SET_SYMLINK: &str = "set.symlink";
/// The set file is not UTF-8 without a byte order mark, not one JSON object nested at most 64
/// levels deep, or escapes a lone surrogate.
pub const RULE_SET_JSON: &str = "set.json";
/// `schema` is missing or is not a number whose value is 1.
pub const RULE_SET_SCHEMA: &str = "set.schema";
/// An unknown key, a key that appears twice, `documents` missing, or a list that is not an array
/// of strings.
pub const RULE_SET_KEY: &str = "set.key";
/// `documents` is empty.
pub const RULE_SET_EMPTY: &str = "set.empty";
/// A path has no normal form or a `..` segment where the list does not allow one.
pub const RULE_SET_PATH: &str = "set.path";
/// A path names a file that an earlier path names.
pub const RULE_SET_DUPLICATE: &str = "set.duplicate";

/// The deepest nesting of the set file's JSON, the object counting as one level.
const MAX_DEPTH: usize = 64;

/// One listed file: its joined path (the set file's prefix followed by the written path) and its
/// bytes, which the caller gives to the byte check ([`super::read_bytes`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetFile {
    pub path: PathBuf,
    pub bytes: Vec<u8>,
}

/// A document set read from its set file: the owned documents and the external documents, each
/// in written order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Set {
    pub documents: Vec<SetFile>,
    pub external: Vec<SetFile>,
}

/// One error of [`read_set`]: its rule, the path it concerns (the set file's path for steps 1 and
/// 2 and for `set.path`, the joined path of the entry otherwise) and a message naming the path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetError {
    pub rule: String,
    pub path: PathBuf,
    pub message: String,
}

impl fmt::Display for SetError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.rule, self.message)
    }
}

impl std::error::Error for SetError {}

fn error(rule: &'static str, path: &Path, message: String) -> SetError {
    SetError { rule: rule.to_owned(), path: path.to_path_buf(), message }
}

/// Reads the set file at `path` and every file it lists, or returns every error in the order of
/// the specification: by step, then by path, `documents` first and then `external`.
pub fn read_set(path: &Path) -> Result<Set, Vec<SetError>> {
    let mut tree = Tree::default();
    let (prefix, bytes) = set_file(&mut tree, path).map_err(|e| vec![e])?;
    let lists = parse(&bytes, path).map_err(|e| vec![e])?;
    let mut errors = Vec::new();
    // Step 3: each path's normal form, then each component of its joined path.
    let mut passed = Vec::new();
    let entries = lists.documents.iter().map(|w| (false, w)).chain(lists.external.iter().map(|w| (true, w)));
    for (external, written) in entries {
        if let Err(reason) = normal_form(written, external) {
            let quoted = serde_json::to_string(written).expect("a string encodes as JSON");
            errors.push(error(RULE_SET_PATH, path, format!("{}: the path {quoted} {reason}", path.display())));
            continue;
        }
        let mut joined = prefix.clone();
        joined.push(written);
        let joined = PathBuf::from(joined);
        match tree.components(&prefix, written, &joined, external) {
            Ok(()) => passed.push((external, joined)),
            Err(e) => errors.push(e),
        }
    }
    // Step 4: one open per file, its bytes and its identity from that handle.
    let mut identities: HashSet<same_file::Handle> = HashSet::new();
    let mut set = Set { documents: Vec::new(), external: Vec::new() };
    for (external, joined) in passed {
        let (bytes, handle) = match read_with_identity(&joined) {
            Ok(read) => read,
            Err(e) => {
                errors.push(error(RULE_SET_FILE, &joined, format!("{}: cannot be read: {e}", joined.display())));
                continue;
            }
        };
        if !identities.insert(handle) {
            errors.push(error(RULE_SET_DUPLICATE, &joined, format!("{}: names a file that an earlier path names", joined.display())));
            continue;
        }
        let file = SetFile { path: joined, bytes };
        if external {
            set.external.push(file);
        } else {
            set.documents.push(file);
        }
    }
    if errors.is_empty() {
        Ok(set)
    } else {
        Err(errors)
    }
}

fn read_with_identity(path: &Path) -> std::io::Result<(Vec<u8>, same_file::Handle)> {
    let mut file = File::open(path)?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok((bytes, same_file::Handle::from_file(file)?))
}

/// Step 1: the set file's name, its root and the file itself, examined without following a
/// symbolic link, then the file's bytes read from one handle. Returns the prefix and the bytes.
fn set_file(tree: &mut Tree, path: &Path) -> Result<(OsString, Vec<u8>), SetError> {
    let shown = path.display();
    let (prefix, last) = platform::split_last(path.as_os_str());
    if !platform::same_name(&last, SET_FILE_NAME) {
        return Err(error(RULE_SET_FILE, path, format!("{shown}: the set file is not named {SET_FILE_NAME}")));
    }
    let root = platform::root(&prefix);
    match tree.kind(&root) {
        Err(e) => return Err(error(RULE_SET_FILE, path, format!("{shown}: the root {} cannot be examined: {e}", Path::new(&root).display()))),
        Ok(Kind::Symlink) => return Err(error(RULE_SET_SYMLINK, path, format!("{shown}: the root {} is a symbolic link", Path::new(&root).display()))),
        Ok(Kind::Dir) => {}
        Ok(_) => return Err(error(RULE_SET_FILE, path, format!("{shown}: the root {} is not a directory", Path::new(&root).display()))),
    }
    match tree.lists(&root, SET_FILE_NAME) {
        Err(e) => return Err(error(RULE_SET_FILE, path, format!("{shown}: the root {} cannot be listed: {e}", Path::new(&root).display()))),
        Ok(false) => return Err(error(RULE_SET_FILE, path, format!("{shown}: the root does not list {SET_FILE_NAME}"))),
        Ok(true) => {}
    }
    match tree.kind(path.as_os_str()) {
        Err(e) => return Err(error(RULE_SET_FILE, path, format!("{shown}: cannot be examined: {e}"))),
        Ok(Kind::Symlink) => return Err(error(RULE_SET_SYMLINK, path, format!("{shown}: is a symbolic link"))),
        Ok(Kind::File) => {}
        Ok(_) => return Err(error(RULE_SET_FILE, path, format!("{shown}: is not a regular file"))),
    }
    let mut bytes = Vec::new();
    File::open(path).and_then(|mut file| file.read_to_end(&mut bytes)).map_err(|e| error(RULE_SET_FILE, path, format!("{shown}: cannot be read: {e}")))?;
    Ok((prefix, bytes))
}

/// The kind of a path examined without following a symbolic link.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Symlink,
    Dir,
    File,
    Other,
}

/// The examined components and listed directories of one read, so that each is examined once.
#[derive(Default)]
struct Tree {
    kinds: HashMap<OsString, Result<Kind, String>>,
    listings: HashMap<OsString, Result<Vec<OsString>, String>>,
}

/// The kind of an entry whose metadata is `meta`.
fn kind_of(meta: &std::fs::Metadata) -> Kind {
    let kind = meta.file_type();
    if kind.is_symlink() {
        Kind::Symlink
    } else if kind.is_dir() {
        Kind::Dir
    } else if kind.is_file() {
        Kind::File
    } else {
        Kind::Other
    }
}

impl Tree {
    /// `lstat`: on Windows the standard library reports a reparse point whose tag is a name
    /// surrogate (a symbolic link or a junction) as a symbolic link.
    fn kind(&mut self, path: &OsStr) -> Result<Kind, String> {
        self.kinds
            .entry(path.to_os_string())
            .or_insert_with(|| std::fs::symlink_metadata(path).map(|meta| kind_of(&meta)).map_err(|e| e.to_string()))
            .clone()
    }

    /// `stat`: the kind of the entry that `path` names, following a symbolic link.
    fn followed_kind(&self, path: &OsStr) -> Result<Kind, String> {
        std::fs::metadata(path).map(|meta| kind_of(&meta)).map_err(|e| e.to_string())
    }

    /// The kind of `path` for step 3: `lstat`, except that an intermediate component of an external
    /// path that is a symbolic link is examined through it.
    fn component_kind(&mut self, path: &OsStr, external: bool, last: bool) -> Result<Kind, String> {
        match self.kind(path) {
            Ok(Kind::Symlink) if external && !last => self.followed_kind(path),
            other => other,
        }
    }

    /// Whether the directory `dir` lists `name`, compared as the platform's own units.
    fn lists(&mut self, dir: &OsStr, name: &str) -> Result<bool, String> {
        let listing = self.listings.entry(dir.to_os_string()).or_insert_with(|| {
            std::fs::read_dir(dir)
                .and_then(|entries| entries.map(|entry| entry.map(|e| e.file_name())).collect::<std::io::Result<Vec<_>>>())
                .map_err(|e| e.to_string())
        });
        match listing {
            Ok(names) => Ok(names.iter().any(|listed| platform::same_name(listed, name))),
            Err(e) => Err(e.clone()),
        }
    }

    /// Step 3 for one path in its normal form: each prefix of the joined path that ends after a
    /// segment of `written`, examined with `lstat`; every one but the last is a directory, the last
    /// is a regular file, none is a symbolic link except an intermediate component of an external
    /// path, and each segment other than `..` is a name that its directory lists.
    fn components(&mut self, prefix: &OsStr, written: &str, joined: &Path, external: bool) -> Result<(), SetError> {
        let shown = joined.display();
        let segments: Vec<&str> = written.split('/').collect();
        let mut dir = platform::root(prefix);
        let mut current = prefix.to_os_string();
        for (index, segment) in segments.iter().enumerate() {
            current.push(segment);
            let component = Path::new(&current).display().to_string();
            let last = index + 1 == segments.len();
            match self.component_kind(&current, external, last) {
                Err(e) => return Err(error(RULE_SET_FILE, joined, format!("{shown}: {component} cannot be examined: {e}"))),
                Ok(Kind::Symlink) => return Err(error(RULE_SET_SYMLINK, joined, format!("{shown}: {component} is a symbolic link"))),
                Ok(Kind::File) if last => {}
                Ok(Kind::Dir) if !last => {}
                Ok(_) if last => return Err(error(RULE_SET_FILE, joined, format!("{shown}: {component} is not a regular file"))),
                Ok(_) => return Err(error(RULE_SET_FILE, joined, format!("{shown}: {component} is not a directory"))),
            }
            if *segment != ".." {
                match self.lists(&dir, segment) {
                    Err(e) => return Err(error(RULE_SET_FILE, joined, format!("{shown}: {} cannot be listed: {e}", Path::new(&dir).display()))),
                    Ok(false) => return Err(error(RULE_SET_FILE, joined, format!("{shown}: {} does not list {segment:?}", Path::new(&dir).display()))),
                    Ok(true) => {}
                }
            }
            dir = current.clone();
            current.push("/");
        }
        Ok(())
    }
}

/// The two lists of a valid set file, as written.
struct Lists {
    documents: Vec<String>,
    external: Vec<String>,
}

/// Step 2: the bytes are UTF-8 without a byte order mark; they hold one JSON object nested at most
/// 64 levels deep with no lone surrogate escaped and no key twice; then the keys, `schema`,
/// `documents` and `external`. Stops at the first error.
fn parse(bytes: &[u8], path: &Path) -> Result<Lists, SetError> {
    let shown = path.display();
    let json = |message: String| error(RULE_SET_JSON, path, format!("{shown}: {message}"));
    let text = std::str::from_utf8(bytes).map_err(|e| json(format!("is not valid UTF-8: {e}")))?;
    if text.starts_with('\u{feff}') {
        return Err(json("begins with a byte order mark".into()));
    }
    let twice = RefCell::new(None);
    let mut deserializer = serde_json::Deserializer::from_str(text);
    let pairs = deserializer.deserialize_map(Object { depth: 1, twice: &twice, keep: true }).and_then(|pairs| deserializer.end().map(|()| pairs));
    let pairs = pairs.map_err(|e| json(format!("is not one JSON object nested at most {MAX_DEPTH} levels deep: {e}")))?;
    if let Some(repeated) = twice.into_inner() {
        return Err(error(RULE_SET_KEY, path, format!("{shown}: the key {repeated:?} appears twice in an object")));
    }
    let key = |message: String| error(RULE_SET_KEY, path, format!("{shown}: {message}"));
    let mut unknown: Vec<&str> = pairs.iter().map(|(k, _)| k.as_str()).filter(|k| !matches!(*k, "schema" | "documents" | "external")).collect();
    if !unknown.is_empty() {
        // Rust orders strings by their UTF-8 bytes, which is code-point order.
        unknown.sort_unstable();
        let names: Vec<String> = unknown.iter().map(|k| serde_json::to_string(k).expect("a string encodes as JSON")).collect();
        return Err(key(format!("has the unknown keys {}", names.join(", "))));
    }
    let value = |name: &str| pairs.iter().find(|(k, _)| k == name).map(|(_, v)| v.get());
    match value("schema") {
        None => return Err(error(RULE_SET_SCHEMA, path, format!("{shown}: schema is missing"))),
        Some(raw) if schema_is_one(raw) => {}
        Some(raw) => return Err(error(RULE_SET_SCHEMA, path, format!("{shown}: schema is {raw}, not the number 1"))),
    }
    let documents = match value("documents") {
        None => return Err(key("documents is missing".into())),
        Some(raw) => serde_json::from_str::<Vec<String>>(raw).map_err(|_| key("documents is not an array of strings".into()))?,
    };
    if documents.is_empty() {
        return Err(error(RULE_SET_EMPTY, path, format!("{shown}: documents is empty")));
    }
    let external = match value("external") {
        None => Vec::new(),
        Some(raw) => serde_json::from_str::<Vec<String>>(raw).map_err(|_| key("external is not an array of strings".into()))?,
    };
    Ok(Lists { documents, external })
}

/// Whether the raw JSON value is a number whose value, read as an IEEE 754 double, is 1. A number
/// beyond the range of a double parses as infinity and is not 1.
fn schema_is_one(raw: &str) -> bool {
    raw.starts_with(|c: char| c == '-' || c.is_ascii_digit()) && raw.parse::<f64>() == Ok(1.0)
}

/// Checks a raw JSON value at nesting level `depth`: an object or array is at most [`MAX_DEPTH`]
/// deep and its members are checked in turn; a string is decoded, which rejects a lone surrogate.
/// A number is not converted, so one beyond the range of a double stays valid JSON.
fn check(raw: &str, depth: usize, twice: &RefCell<Option<String>>) -> Result<(), serde_json::Error> {
    match raw.as_bytes().first() {
        Some(b'{') | Some(b'[') if depth > MAX_DEPTH => Err(de::Error::custom(format!("nested more than {MAX_DEPTH} levels deep"))),
        Some(b'{') => serde_json::Deserializer::from_str(raw).deserialize_map(Object { depth, twice, keep: false }).map(|_| ()),
        Some(b'[') => serde_json::Deserializer::from_str(raw).deserialize_seq(Object { depth, twice, keep: false }).map(|_| ()),
        Some(b'"') => serde_json::from_str::<String>(raw).map(|_| ()),
        _ => Ok(()),
    }
}

/// The serde visitor of an object or array at level `depth`: it takes each member as a raw value,
/// records the first key that appears twice in an object in `twice`, and checks each member at the
/// next level. The top
/// object keeps its pairs.
struct Object<'a> {
    depth: usize,
    twice: &'a RefCell<Option<String>>,
    keep: bool,
}

impl<'de> Visitor<'de> for Object<'_> {
    type Value = Vec<(String, &'de RawValue)>;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(if self.depth == 1 { "a JSON object" } else { "a JSON value" })
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut keys = HashSet::new();
        let mut pairs = Vec::new();
        while let Some(key) = map.next_key::<String>()? {
            // A key twice is set.key, which the reader reports only after the whole text met the
            // set.json conditions, so the first one is recorded and the parse goes on.
            if !keys.insert(key.clone()) {
                self.twice.borrow_mut().get_or_insert_with(|| key.clone());
            }
            let value: &'de RawValue = map.next_value()?;
            check(value.get(), self.depth + 1, self.twice).map_err(de::Error::custom)?;
            if self.keep {
                pairs.push((key, value));
            }
        }
        Ok(pairs)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        while let Some(value) = seq.next_element::<&'de RawValue>()? {
            check(value.get(), self.depth + 1, self.twice).map_err(de::Error::custom)?;
        }
        Ok(Vec::new())
    }
}

/// The normal form of a written path, or the reason it has none. An `external` path may begin
/// with `..` segments; a `documents` path has none.
fn normal_form(written: &str, external: bool) -> Result<(), &'static str> {
    let mut leading = external;
    let segments: Vec<&str> = written.split('/').collect();
    for segment in &segments {
        if *segment == ".." {
            if leading {
                continue;
            }
            return Err(if external { "has a .. segment after another segment" } else { "has a .. segment" });
        }
        leading = false;
        segment_form(segment)?;
    }
    if !segments.last().is_some_and(|last| last.ends_with(".dbs")) {
        return Err("does not end in .dbs");
    }
    Ok(())
}

fn segment_form(segment: &str) -> Result<(), &'static str> {
    if segment.is_empty() {
        return Err("has an empty segment");
    }
    if segment.chars().any(|c| matches!(c, '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*' | '\0'..='\u{1f}')) {
        return Err("has a character that a segment cannot hold");
    }
    if segment == "." {
        return Err("has a . segment");
    }
    if segment.ends_with('.') || segment.ends_with(' ') {
        return Err("has a segment ending in . or a space");
    }
    let base = segment.split('.').next().unwrap_or("").trim_end_matches(' ');
    if device(base) {
        return Err("has a segment that is a device name of Windows");
    }
    Ok(())
}

/// Whether `base` is, ignoring ASCII case, a device name of Windows.
fn device(base: &str) -> bool {
    if ["CON", "PRN", "AUX", "NUL"].iter().any(|d| base.eq_ignore_ascii_case(d)) {
        return true;
    }
    let (Some(head), Some(tail)) = (base.get(..3), base.get(3..)) else { return false };
    let mut rest = tail.chars();
    (head.eq_ignore_ascii_case("COM") || head.eq_ignore_ascii_case("LPT")) && matches!((rest.next(), rest.next()), (Some('0'..='9' | '¹' | '²' | '³'), None))
}

// The path operations of each platform, in modules of their own names so that each has its own
// symbols; `platform` names the one the target compiles.
#[cfg(unix)]
use posix as platform;
#[cfg(windows)]
use windows as platform;

#[cfg(unix)]
mod posix {
    use std::ffi::{OsStr, OsString};
    use std::os::unix::ffi::{OsStrExt, OsStringExt};

    /// The prefix (through the last `/`) and the last segment of `path`.
    pub fn split_last(path: &OsStr) -> (OsString, OsString) {
        let bytes = path.as_bytes();
        let at = bytes.iter().rposition(|b| *b == b'/').map_or(0, |i| i + 1);
        (OsString::from_vec(bytes[..at].to_vec()), OsString::from_vec(bytes[at..].to_vec()))
    }

    /// The root of a prefix: `.` when it is empty, and otherwise the prefix without its trailing
    /// separators, since `lstat` of a path ending in `/` follows a symbolic link. A prefix of only
    /// separators is `/`.
    pub fn root(prefix: &OsStr) -> OsString {
        let bytes = prefix.as_bytes();
        if bytes.is_empty() {
            return OsString::from(".");
        }
        let end = bytes.iter().rposition(|b| *b != b'/').map_or(1, |i| i + 1);
        OsString::from_vec(bytes[..end].to_vec())
    }

    /// Whether a listed name equals `name`: their UTF-8 bytes are equal.
    pub fn same_name(listed: &OsStr, name: &str) -> bool {
        listed.as_bytes() == name.as_bytes()
    }
}

#[cfg(windows)]
mod windows {
    use std::ffi::{OsStr, OsString};
    use std::os::windows::ffi::{OsStrExt, OsStringExt};

    fn separator(unit: u16) -> bool {
        unit == u16::from(b'/') || unit == u16::from(b'\\')
    }

    /// The prefix (through the last `/` or `\`) and the last segment of `path`.
    pub fn split_last(path: &OsStr) -> (OsString, OsString) {
        let units: Vec<u16> = path.encode_wide().collect();
        let at = units.iter().rposition(|u| separator(*u)).map_or(0, |i| i + 1);
        (OsString::from_wide(&units[..at]), OsString::from_wide(&units[at..]))
    }

    /// The root of a prefix: `.` when it is empty, the prefix itself when it ends in no separator
    /// (such as `C:`), and otherwise the prefix without its trailing separators, keeping one where
    /// removing it would change the directory (`\` or `C:\`).
    pub fn root(prefix: &OsStr) -> OsString {
        let units: Vec<u16> = prefix.encode_wide().collect();
        if units.is_empty() {
            return OsString::from(".");
        }
        let end = units.iter().rposition(|u| !separator(*u)).map_or(0, |i| i + 1);
        if end == units.len() {
            return prefix.to_os_string();
        }
        if end == 0 || units[end - 1] == u16::from(b':') {
            return OsString::from_wide(&units[..end + 1]);
        }
        OsString::from_wide(&units[..end])
    }

    /// Whether a listed name equals `name`: their UTF-16 code units are equal.
    pub fn same_name(listed: &OsStr, name: &str) -> bool {
        listed.encode_wide().eq(name.encode_utf16())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The normal form: each rule of a segment has an accepting and a rejecting case.
    // Requirements: DBS-7, DBS-8, DBS-9, DBS-10.
    #[test]
    fn normal_form_cases() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        for (written, external) in [
            ("shop.dbs", false),
            ("a/b.dbs", false),
            ("../core/core.dbs", true),
            ("../../x.dbs", true),
            ("console.dbs", false),
            ("com10.dbs", false),
            ("lpt.dbs", false),
            (".dbs", false),
        ] {
            assert_eq!(normal_form(written, external), Ok(()), "{written}");
        }
        for (written, external) in [
            ("", false),
            ("..", true),
            ("../x.dbs", false),
            ("a/../x.dbs", true),
            ("x.dbs/", false),
            ("C:x.dbs", false),
            ("COM³.dbs", false),
            ("aux", false),
            ("Nul .x.dbs", false),
            ("a\u{1f}.dbs", false),
        ] {
            assert!(normal_form(written, external).is_err(), "{written}");
        }
    }

    // The root keeps no trailing separator, so that lstat does not follow a symbolic link.
    // Requirements: DBS-12.
    #[cfg(unix)]
    #[test]
    fn root_of_prefix() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        for (prefix, root) in [("", "."), ("/", "/"), ("a/", "a"), ("a//", "a"), ("/a/b/", "/a/b")] {
            assert_eq!(platform::root(OsStr::new(prefix)), OsString::from(root), "{prefix:?}");
        }
        assert_eq!(platform::split_last(OsStr::new("a/b/dbspec-set.json")), (OsString::from("a/b/"), OsString::from("dbspec-set.json")));
        assert_eq!(platform::split_last(OsStr::new("dbspec-set.json")), (OsString::new(), OsString::from("dbspec-set.json")));
    }

    // Nested values are checked by the same rules as the top object: a number beyond a double
    // stays valid JSON, a key twice is set.key, and a lone surrogate is set.json at any level.
    // Requirements: DBS-13, DBS-21, DBS-23.
    #[test]
    fn nested_json_rules() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        let path = Path::new("dbspec-set.json");
        for (text, rule) in [
            (r#"{"schema": 1, "documents": ["a.dbs"], "x": [1e400]}"#, RULE_SET_KEY),
            (r#"{"schema": 1, "documents": ["a.dbs"], "x": {"a": 1, "a": 2}}"#, RULE_SET_KEY),
            (r#"{"schema": 1, "documents": ["a.dbs"], "x": [{"k": "\ud800"}]}"#, RULE_SET_JSON),
            (r#"{"schema": 1, "documents": ["a.dbs"], "x": {"\udc00": 1}}"#, RULE_SET_JSON),
            (r#"{"schema": 1, "documents": ["a.dbs"], "x": "😀"}"#, RULE_SET_KEY),
            (r#"{"schema": 1, "documents": ["a.dbs"]}  "#, ""),
            // A key twice is reported only after the set.json conditions of the whole text.
            (r#"{"schema": {"a": 1, "a": 2}, "documents": ["a.dbs"]}"#, RULE_SET_KEY),
            (r#"{"a": 1, "a": 2, "x": "\ud800"}"#, RULE_SET_JSON),
            (
                r#"{"x": {"a": 1, "a": 2}, "y": [[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]}"#,
                RULE_SET_JSON,
            ),
            (r#"{"a": 1, "a": 2,"#, RULE_SET_JSON),
            (r#"{"schema": NaN, "documents": ["a.dbs"]}"#, RULE_SET_JSON),
            (r#"{"schema": Infinity, "documents": ["a.dbs"]}"#, RULE_SET_JSON),
        ] {
            let got = parse(text.as_bytes(), path).err().map_or(String::new(), |e| e.rule);
            assert_eq!(got, rule, "{text}");
        }
    }

    // A schema equal to 1 as a double is accepted; any other value is not.
    // Requirements: DBS-22.
    #[test]
    fn schema_values() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        for raw in ["1", "1.0", "1e0", "10e-1", "1.0000000000000000001"] {
            assert!(schema_is_one(raw), "{raw}");
        }
        for raw in ["2", "-1", "1e400", "\"1\"", "true", "null"] {
            assert!(!schema_is_one(raw), "{raw}");
        }
    }
}

/// The result of one text of a set (docs/spec/dbspec.md "Parsing a set"): the name that the parser reads
/// from its header, `None` when the header fails; whether the text is external; and what one parse
/// of the text returns, its document and positions or its diagnostics.
#[derive(Clone, Debug)]
pub struct SetDocument {
    pub name: Option<String>,
    pub external: bool,
    pub document: Option<super::Document>,
    pub positions: Vec<super::Position>,
    pub diagnostics: Vec<super::Diagnostic>,
}

/// Parses the texts of one document set (docs/spec/dbspec.md "Parsing a set"). Each text's name is the
/// name the parser reads from its header; a text whose name an earlier text has is not parsed, and
/// its own result carries the `name.duplicate` diagnostic. The results are owned first, each in set
/// order. Every other text is parsed with the texts of all other named documents
/// as the documents its `use` lines name.
pub fn parse_set(owned: &[&str], external: &[&str]) -> Vec<SetDocument> {
    let mut out: Vec<SetDocument> = Vec::new();
    let mut named: BTreeMap<String, String> = BTreeMap::new();
    // The texts to parse: the text and the index of its result.
    let mut parse: Vec<(&str, usize)> = Vec::new();
    let texts = owned.iter().map(|t| (*t, false)).chain(external.iter().map(|t| (*t, true)));
    for (text, is_external) in texts {
        let name = super::parser::header_name(text);
        out.push(SetDocument { name: name.clone(), external: is_external, document: None, positions: Vec::new(), diagnostics: Vec::new() });
        let index = out.len() - 1;
        if let Some(name) = name {
            if named.contains_key(&name) {
                out[index].diagnostics.push(super::Diagnostic {
                    rule: "name.duplicate".to_owned(),
                    line: 1,
                    column: 10,
                    message: format!("document {name} appears twice in the document set"),
                });
                continue;
            }
            named.insert(name, text.to_owned());
        }
        parse.push((text, index));
    }
    for (text, index) in parse {
        let result = &mut out[index];
        let others: BTreeMap<String, String> =
            named.iter().filter(|(name, _)| Some(*name) != result.name.as_ref()).map(|(k, v)| (k.clone(), v.clone())).collect();
        match super::parse(text, &others) {
            Ok(parsed) => {
                let mut document = parsed.document;
                document.external = result.external;
                result.document = Some(document);
                result.positions = parsed.positions;
            }
            Err(diagnostics) => result.diagnostics = diagnostics,
        }
    }
    out
}
