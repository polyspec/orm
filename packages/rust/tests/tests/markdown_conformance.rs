//! markdown IR executor conformance (tests/markdown/README.md): runs every case in tests/markdown/cases.json, in order,
//! with this client, against one server of the flowmark build that FLOWMARK points to. That build
//! must be the one pinned by tests/markdown/flowmark.version; if it is missing or a different build, the test fails (it does not
//! skip). The cases run in polyspec_orm_tests::markdown; the model is made by build.rs from tests/markdown/corpus/dbspec/conformance.dbs.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Mutex;

use polyspec_orm_tests::markdown::{self, Scratch, Served, Server};
use serde_json::{json, Value};

/// The module path that must be the main module of the build FLOWMARK points to.
const FLOWMARK_MODULE: &str = "github.com/polyspec/flowmark/packages/go";

/// The case this runner implements. It must equal the case set in cases.json.
const CASES: &[&str] = &[
    "insert_one",
    "insert_rows",
    "insert_rows_tasks",
    "insert_identity",
    "one",
    "one_no_rows",
    "all",
    "count",
    "group_count",
    "group_count_no_rows",
    "group_count_views",
    "group_count_i64",
    "collection_typed_key",
    "collection_key_name",
    "sum",
    "avg",
    "paginate",
    "join",
    "relation_many",
    "relation_one",
    "update",
    "update_optimistic_conflict",
    "insert_on_duplicate",
    "delete",
    "delete_referenced",
    "soft_delete",
    "restore",
    "transaction_commit",
    "transaction_rollback",
    "savepoint_rollback",
    "read_only_write",
    "lock_update",
    "lock_nowait",
    "get_query",
    "isolation",
    "write_conflict",
    "transaction_retry_commit",
    "connect_corpus_mismatch",
    "connect_token_mismatch",
    "order_nulls",
    "order_random",
    "primary_key_case",
    "tuple_in",
    "subquery_aggregate",
    "scalar_column_subquery",
    "column_pairs",
    "contains",
    "contains_binary",
    "now_truncated",
    "index_read",
    "force_index",
    "unavailable_table",
    "codec_insert",
    "codec_default_select",
    "codec_explicit_select",
    "codec_update",
    "select_explicit_insert_omitted",
    "select_explicit_read_null",
    "install_aes",
    "install_audit",
];

/// The flowmark server that the cases share, on the runtime that runs them. A later case reads the corpus state that the
/// cases before it made, so after a failure the later cases fail with the case that stopped them.
struct Shared {
    runtime: tokio::runtime::Runtime,
    served: Served,
    _server: Server,
    _scratch: Scratch,
    stopped: Option<String>,
}

static SHARED: Mutex<Option<Shared>> = Mutex::new(None);

/// Starts the pinned flowmark build on a new corpus. The Rust cases are exactly the cases of cases.json.
fn start() -> Shared {
    let bin = pinned_flowmark();
    let ids: Vec<String> = load_cases().into_iter().map(|(id, _)| id).collect();
    let missing: Vec<&str> = ids.iter().map(String::as_str).filter(|id| !CASES.contains(id)).collect();
    let extra: BTreeSet<&str> = CASES.iter().copied().filter(|id| !ids.iter().any(|i| i == id)).collect();
    assert!(missing.is_empty() && extra.is_empty(), "cases.json and the Rust cases differ: missing in Rust {missing:?}, not in cases.json {extra:?}");
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("a current-thread runtime");
    let scratch = Scratch(std::env::temp_dir().join(format!("orm-markdown-{}-{}", std::process::id(), markdown::unique())));
    let (served, server) = runtime.block_on(markdown::serve(&bin, &scratch.0));
    Shared { runtime, served, _server: server, _scratch: scratch, stopped: None }
}

/// Runs one case of cases.json on the shared server, which the first case starts.
fn markdown_conformance_case(id: &str, expect: &Value) {
    // A trial fails by a panic, which poisons the lock; the next trial takes the server and reports the stopped case.
    let mut guard = match SHARED.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let shared = guard.get_or_insert_with(start);
    if let Some(stopped) = &shared.stopped {
        panic!("not run: {stopped} failed, and this case reads the corpus state it leaves");
    }
    let got = match shared.runtime.block_on(markdown::run_case(id, &shared.served)) {
        Ok(value) => value,
        Err(error) => json!({ "error": error.code() }),
    };
    if !markdown::same(&got, expect) {
        shared.stopped = Some(id.to_owned());
        panic!("{id}: got {got}, want {expect}");
    }
}

/// Each case of tests/markdown/cases.json is the trial `markdown_conformance::<id>`, in the order of the file.
fn main() {
    let trials = load_cases()
        .into_iter()
        .map(|(id, expect)| {
            polyspec_orm_testcase::trial(format!("markdown_conformance::{id}"), polyspec_orm_testcase::PROCESS, move || markdown_conformance_case(&id, &expect))
        })
        .collect();
    polyspec_orm_testcase::run_in_order_then(trials, || {
        let mut guard = match SHARED.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(shared) = guard.take() {
            shared.runtime.block_on(shared.served.db.close());
        }
    });
}

/// The cases from cases.json: returns each id and expect in order. Fails if an id is empty or duplicated.
fn load_cases() -> Vec<(String, Value)> {
    let path = markdown::conformance_dir().join("cases.json");
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) => panic!("{}: {e}", path.display()),
    };
    let doc: Value = match serde_json::from_str(&text) {
        Ok(doc) => doc,
        Err(e) => panic!("{}: {e}", path.display()),
    };
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for case in doc["cases"].as_array().unwrap_or_else(|| panic!("{}: no cases", path.display())) {
        let id = case["id"].as_str().unwrap_or_default().to_owned();
        assert!(!id.is_empty() && seen.insert(id.clone()), "cases.json: case id {id:?} is empty or repeated");
        out.push((id, case["expect"].clone()));
    }
    out
}

/// The flowmark binary that FLOWMARK points to. Accepts the pinned module version or a clean build of its exact revision.
fn pinned_flowmark() -> PathBuf {
    let version = markdown::conformance_dir().join("flowmark.version");
    let pin = match std::fs::read_to_string(&version) {
        Ok(text) => text.trim().to_owned(),
        Err(e) => panic!("{}: {e}", version.display()),
    };
    let bin = match std::env::var("FLOWMARK") {
        Ok(bin) if !bin.is_empty() => bin,
        unset => panic!(
            "FLOWMARK is not set ({unset:?}); run make markdown-conformance-check, which passes the path of the flowmark {pin} pinned in tests/markdown/flowmark.version"
        ),
    };
    let bytes = match std::fs::read(&bin) {
        Ok(bytes) => bytes,
        Err(e) => panic!("FLOWMARK {bin}: {e}; run make orm-install-flowmark, which installs the flowmark {pin} pinned in tests/markdown/flowmark.version"),
    };
    let main = main_module(&bytes).unwrap_or_else(|| {
        panic!("FLOWMARK {bin} is no Go build; run make orm-install-flowmark, which installs the flowmark {pin} pinned in tests/markdown/flowmark.version")
    });
    let pinned_revision = pin.rsplit('-').next().unwrap_or("");
    let installed = main.path == FLOWMARK_MODULE && main.version == pin;
    let checkout = main.path == FLOWMARK_MODULE && main.version == "(devel)" && main.revision.starts_with(pinned_revision) && main.modified == "false";
    assert!(
        installed || checkout,
        "FLOWMARK {bin} is {main:?}, not the pinned {FLOWMARK_MODULE} {pin} or a clean checkout at that revision; run make orm-install-flowmark, or build the exact Flowmark revision"
    );
    PathBuf::from(bin)
}

#[derive(Debug)]
struct GoBuildInfo {
    path: String,
    version: String,
    revision: String,
    modified: String,
}

/// Reads the main module and VCS settings from the Go binary's build info between the linker's 16-byte markers.
fn main_module(binary: &[u8]) -> Option<GoBuildInfo> {
    const START: [u8; 16] = [0x30, 0x77, 0xaf, 0x0c, 0x92, 0x74, 0x08, 0x02, 0x41, 0xe1, 0xc1, 0x07, 0xe6, 0xd6, 0x18, 0xe6];
    const END: [u8; 16] = [0xf9, 0x32, 0x43, 0x31, 0x86, 0x18, 0x20, 0x72, 0x00, 0x82, 0x42, 0x10, 0x41, 0x16, 0xd8, 0xf2];
    let start = binary.windows(START.len()).position(|w| w == START)? + START.len();
    let end = start + binary[start..].windows(END.len()).position(|w| w == END)?;
    // Text that is not UTF-8 between the markers is no Go build info.
    let Ok(text) = std::str::from_utf8(&binary[start..end]) else { return None };
    let mut path = None;
    let mut version = None;
    let mut revision = None;
    let mut modified = None;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("mod\t") {
            let mut fields = rest.split('\t');
            path = fields.next().map(str::to_owned);
            version = fields.next().map(str::to_owned);
        } else if let Some(value) = line.strip_prefix("build\tvcs.revision=") {
            revision = Some(value.to_owned());
        } else if let Some(value) = line.strip_prefix("build\tvcs.modified=") {
            modified = Some(value.to_owned());
        }
    }
    Some(GoBuildInfo { path: path?, version: version?, revision: revision.unwrap_or_default(), modified: modified.unwrap_or_default() })
}
