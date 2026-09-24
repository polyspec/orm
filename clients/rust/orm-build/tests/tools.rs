//! DDL, migration diff, live schema rendering, and migration file rules.

use std::collections::BTreeMap;

use orm_build::ddl::{render_ddl, render_diff};
use orm_build::live::{self, Column, ForeignKey, Table, NO_DEFAULT};
use orm_build::migration::{plan_id, plan_operations, plan_sql, split_sql, Log, PlanFile, Record};
use orm_build::schema::{self, Check, Col, Entity, Manifest, Ref, Rel, RelKey};

fn col(name: &str, typ: &str, raw: &str) -> Col {
    Col { name: name.into(), typ: typ.into(), raw: raw.into(), ..Default::default() }
}

fn id() -> Col {
    Col { pk: true, ..col("id", "i64", "bigint") }
}

fn entity(name: &str, columns: Vec<Col>) -> Entity {
    Entity { name: name.into(), table: name.into(), pk: vec!["id".into()], columns, ..Default::default() }
}

fn manifest(hash: &str, entities: Vec<Entity>) -> Manifest {
    Manifest {
        schema_hash: hash.into(),
        order: entities.iter().map(|e| e.name.clone()).collect(),
        entities: entities.into_iter().map(|e| (e.name.clone(), e)).collect(),
        ..Default::default()
    }
}

fn thing(columns: Vec<Col>) -> Manifest {
    manifest("test", vec![entity("thing", columns)])
}

fn contains_all(sql: &str, wants: &[&str]) {
    for want in wants {
        assert!(sql.contains(want), "missing {want:?}:\n{sql}");
    }
}

fn ordered(sql: &str, parts: &[&str]) {
    let positions: Vec<Option<usize>> = parts.iter().map(|p| sql.find(p)).collect();
    assert!(positions.iter().all(Option::is_some), "missing parts {parts:?}:\n{sql}");
    assert!(positions.windows(2).all(|w| w[0] < w[1]), "order {parts:?}:\n{sql}");
}

#[test]
fn diff_add_column_is_safe_and_drop_is_destructive() {
    let old = thing(vec![id()]);
    let now = thing(vec![id(), Col { len: 20, ..col("name", "string", "varchar(20)") }]);
    contains_all(&render_diff(&old, &now, "mysql", false).unwrap(), &["ALTER TABLE `thing` ADD COLUMN `name` varchar(20) NOT NULL;"]);
    let err = render_diff(&now, &old, "mysql", false).unwrap_err();
    assert!(err.contains("--allow-destructive"), "{err}");
    contains_all(&render_diff(&now, &old, "mysql", true).unwrap(), &["DROP COLUMN `name`"]);
    let wide = thing(vec![id(), col("z", "string", "text"), col("a", "string", "text")]);
    assert_eq!(render_diff(&old, &wide, "postgres", false), render_diff(&old, &wide, "postgres", false));
}

#[test]
fn ddl_quotes_qualified_tables_and_uses_instants() {
    let mut m = thing(vec![id(), Col { precision: 6, ..col("created_at", "datetime", "datetime(6)") }]);
    m.entities.get_mut("thing").unwrap().table = "core.thing".into();
    m.entities.get_mut("thing").unwrap().indexes.insert("expiry".into(), vec!["id".into()]);
    let pg = render_ddl(&m, "postgres").unwrap();
    contains_all(&pg, &[r#"CREATE TABLE "core"."thing""#, r#""created_at" timestamp(6) with time zone NOT NULL"#]);
    assert!(!pg.contains(r#"CREATE TABLE "core.thing""#));
    let sqlite = render_ddl(&m, "sqlite").unwrap();
    contains_all(&sqlite, &[r#"CREATE TABLE "core__thing""#, r#"CREATE INDEX "core__thing_expiry""#]);
}

#[test]
fn diff_adds_and_drops_indexes_and_constraints() {
    let base = || vec![id(), Col { len: 20, ..col("old_code", "string", "varchar(20)") }, Col { nullable: true, ..col("body", "text", "text") }];
    let mut old = thing(base());
    let e = old.entities.get_mut("thing").unwrap();
    e.indexes = BTreeMap::from([("old_code_idx".into(), vec!["old_code".into()])]);
    e.unique = vec![vec!["old_code".into()]];
    e.fulltext = vec![vec!["body".into()]];
    let mut now = thing(base());
    let e = now.entities.get_mut("thing").unwrap();
    e.indexes = BTreeMap::from([("body_idx".into(), vec!["body".into()])]);
    e.unique = vec![vec!["id".into(), "old_code".into()]];
    e.fulltext = vec![vec!["old_code".into(), "body".into()]];
    contains_all(
        &render_diff(&old, &now, "mysql", true).unwrap(),
        &[
            "DROP INDEX `old_code_idx` ON `thing`;",
            "DROP INDEX `uq_thing_old_code` ON `thing`;",
            "DROP INDEX `ft_body` ON `thing`;",
            "CREATE INDEX `body_idx` ON `thing` (`body`);",
            "CREATE UNIQUE INDEX `uq_thing_id_old_code` ON `thing` (`id`, `old_code`);",
            "CREATE FULLTEXT INDEX `ft_old_code_body` ON `thing` (`old_code`, `body`);",
        ],
    );
}

#[test]
fn postgres_diff_changes_type_nullability_and_default() {
    let old = thing(vec![id(), Col { len: 20, nullable: true, default: Some("draft".into()), ..col("status", "string", "varchar(20)") }]);
    let now = thing(vec![id(), Col { len: 40, default: Some("published".into()), ..col("status", "string", "varchar(40)") }]);
    contains_all(
        &render_diff(&old, &now, "postgres", true).unwrap(),
        &[
            r#"ALTER TABLE "thing" ALTER COLUMN "status" TYPE varchar(40);"#,
            r#"ALTER TABLE "thing" ALTER COLUMN "status" SET NOT NULL;"#,
            r#"ALTER TABLE "thing" ALTER COLUMN "status" SET DEFAULT 'published';"#,
        ],
    );
}

fn account_thing(action: &str, index: Option<&str>) -> Manifest {
    let parent = entity("account", vec![id()]);
    let mut child = entity(
        "thing",
        vec![id(), Col { fk: true, reference: Some(Ref { entity: "account".into(), column: "id".into() }), ..col("account_id", "i64", "bigint") }],
    );
    child.relations.insert(
        "account".into(),
        Rel {
            name: "account".into(),
            kind: "one".into(),
            target: "account".into(),
            keys: vec![RelKey { local: "account_id".into(), target: "id".into() }],
            on_delete: action.into(),
            foreign_key: false,
        },
    );
    if let Some(index) = index {
        child.indexes.insert(index.into(), vec!["account_id".into()]);
    }
    manifest(action, vec![parent, child])
}

#[test]
fn ddl_includes_foreign_keys_and_delete_actions() {
    let m = account_thing("cascade", None);
    for (dialect, want) in [
        ("mysql", "CONSTRAINT `fk_thing_account_id` FOREIGN KEY (`account_id`) REFERENCES `account` (`id`) ON DELETE CASCADE"),
        ("postgres", r#"CONSTRAINT "fk_thing_account_id" FOREIGN KEY ("account_id") REFERENCES "account" ("id") ON DELETE CASCADE"#),
        ("sqlite", r#"CONSTRAINT "fk_thing_account_id" FOREIGN KEY ("account_id") REFERENCES "account" ("id") ON DELETE CASCADE"#),
    ] {
        contains_all(&render_ddl(&m, dialect).unwrap(), &[want]);
    }
    contains_all(
        &render_diff(&account_thing("", None), &account_thing("setnull", None), "postgres", true).unwrap(),
        &[
            r#"ALTER TABLE "thing" DROP CONSTRAINT "fk_thing_account_id";"#,
            r#"ALTER TABLE "thing" ADD CONSTRAINT "fk_thing_account_id" FOREIGN KEY ("account_id") REFERENCES "account" ("id") ON DELETE SET NULL;"#,
        ],
    );
    let old = account_thing("", Some("old_account_idx"));
    let mut now = account_thing("", Some("new_account_idx"));
    now.entities.get_mut("thing").unwrap().relations.get_mut("account").unwrap().on_delete = "cascade".into();
    ordered(
        &render_diff(&old, &now, "mysql", true).unwrap(),
        &["DROP FOREIGN KEY", "DROP INDEX `old_account_idx`", "CREATE INDEX `new_account_idx`", "ADD CONSTRAINT `fk_thing_account_id`"],
    );
}

#[test]
fn ddl_and_diff_preserve_checks() {
    let base = || vec![id(), col("quantity", "i32", "int")];
    let mut m = thing(base());
    m.entities.get_mut("thing").unwrap().checks = vec![Check { name: "positive_quantity".into(), expr: "`quantity` >= 0".into() }];
    contains_all(&render_ddl(&m, "mysql").unwrap(), &["CONSTRAINT `ck_thing_positive_quantity` CHECK ((`quantity` >= 0) <> 0)"]);
    let mut old = thing(base());
    contains_all(&render_diff(&old, &m, "postgres", false).unwrap(), &[r#"ADD CONSTRAINT "positive_quantity" CHECK ("quantity" >= 0);"#]);
    old.entities.get_mut("thing").unwrap().checks = m.entities["thing"].checks.clone();
    m.entities.get_mut("thing").unwrap().checks[0].expr = "`quantity` > 0".into();
    contains_all(&render_diff(&old, &m, "sqlite", true).unwrap(), &[r#"CONSTRAINT "positive_quantity" CHECK ("quantity" > 0)"#]);
}

#[test]
fn ddl_orders_parents_and_indexes() {
    let parent = entity("parent", vec![id()]);
    let child = entity("child", vec![id(), Col { reference: Some(Ref { entity: "parent".into(), column: "id".into() }), ..col("parent_id", "i64", "bigint") }]);
    let m = manifest("test", vec![child, parent]);
    ordered(
        &render_ddl(&m, "postgres").unwrap(),
        &[r#"DROP TABLE IF EXISTS "child""#, r#"DROP TABLE IF EXISTS "parent""#, r#"CREATE TABLE "parent""#, r#"CREATE TABLE "child""#],
    );
    let mut m = thing(vec![id(), col("a", "string", "text"), col("m", "string", "text"), col("z", "string", "text")]);
    m.entities.get_mut("thing").unwrap().indexes =
        BTreeMap::from([("z_idx".into(), vec!["z".into()]), ("a_idx".into(), vec!["a".into()]), ("m_idx".into(), vec!["m".into()])]);
    ordered(&render_ddl(&m, "postgres").unwrap(), &[r#""thing_a_idx""#, r#""thing_m_idx""#, r#""thing_z_idx""#]);
}

fn renamed(from: &str, column_from: &str) -> Manifest {
    let mut e = entity("customer", vec![id(), Col { len: 40, renamed_from: column_from.into(), ..col("display_name", "string", "varchar(40)") }]);
    e.renamed_from = from.into();
    manifest("new", vec![e])
}

#[test]
fn diff_uses_explicit_renames() {
    let old = manifest("old", vec![entity("account", vec![id(), Col { len: 40, ..col("name", "string", "varchar(40)") }])]);
    let now = renamed("account", "name");
    let forward = render_diff(&old, &now, "postgres", false).unwrap();
    contains_all(&forward, &[r#"ALTER TABLE "account" RENAME TO "customer";"#, r#"ALTER TABLE "customer" RENAME COLUMN "name" TO "display_name";"#]);
    assert!(!forward.contains("DROP TABLE"));
    contains_all(
        &render_diff(&now, &old, "postgres", false).unwrap(),
        &[r#"ALTER TABLE "customer" RENAME TO "account";"#, r#"ALTER TABLE "account" RENAME COLUMN "display_name" TO "name";"#],
    );
    let missing = renamed("missing", "");
    let err = render_diff(&thing(vec![id()]), &missing, "postgres", true).unwrap_err();
    assert!(err.contains("rename source"), "{err}");
    let current = manifest("current", vec![entity("customer", vec![id(), Col { len: 40, ..col("display_name", "string", "varchar(40)") }])]);
    contains_all(&render_diff(&current, &now, "postgres", false).unwrap(), &["-- no changes"]);
}

#[test]
fn diff_drops_child_constraints_before_table_rename() {
    let owner = || entity("owner", vec![id()]);
    let mut entry =
        entity("entry", vec![id(), Col { reference: Some(Ref { entity: "owner".into(), column: "id".into() }), ..col("owner_id", "i64", "bigint") }]);
    entry.indexes.insert("owner_idx".into(), vec!["owner_id".into()]);
    entry.relations.insert(
        "owner".into(),
        Rel {
            name: "owner".into(),
            kind: "one".into(),
            target: "owner".into(),
            keys: vec![RelKey { local: "owner_id".into(), target: "id".into() }],
            ..Default::default()
        },
    );
    let mut record = entry.clone();
    record.name = "record".into();
    record.table = "record".into();
    record.renamed_from = "entry".into();
    record.indexes = BTreeMap::from([("owner_new_idx".into(), vec!["owner_id".into()])]);
    let old = manifest("old", vec![owner(), entry]);
    let now = manifest("new", vec![owner(), record]);
    ordered(
        &render_diff(&old, &now, "mysql", false).unwrap(),
        &["DROP INDEX `owner_idx` ON `entry`", "ALTER TABLE `entry` RENAME TO `record`", "CREATE INDEX `owner_new_idx` ON `record`"],
    );
}

fn column(name: &str, typ: &str, key: &str) -> Column {
    Column { name: name.into(), typ: typ.into(), key: key.into(), default: NO_DEFAULT.into(), ..Default::default() }
}

#[test]
fn render_mermaid_restores_foreign_keys() {
    let tables = vec![
        Table { name: "owner".into(), columns: vec![column("id", "bigint", "PRI")], ..Default::default() },
        Table {
            name: "item".into(),
            columns: vec![column("id", "bigint", "PRI"), column("owner_id", "bigint", "")],
            foreign_keys: vec![ForeignKey {
                name: "fk_item_owner_id".into(),
                columns: vec!["owner_id".into()],
                target: "owner".into(),
                target_columns: vec!["id".into()],
                on_delete: "cascade".into(),
            }],
            ..Default::default()
        },
    ];
    let source = live::render_mermaid(&tables, None);
    assert!(source.contains(": owner_id cascade"), "{source}");
    let m = schema::build(&[schema::parse(&source).unwrap()]).unwrap();
    let item = &m.entities["item"];
    assert_eq!(item.column("owner_id").unwrap().reference, Some(Ref { entity: "owner".into(), column: "id".into() }));
    assert_eq!(item.relations["owner"].on_delete, "cascade");

    let tables = vec![
        Table { name: "account".into(), columns: vec![column("tenant_id", "bigint", "PRI"), column("id", "bigint", "PRI")], ..Default::default() },
        Table {
            name: "membership".into(),
            columns: vec![column("tenant_id", "bigint", "PRI"), column("account_id", "bigint", "PRI")],
            foreign_keys: vec![ForeignKey {
                name: "fk_membership_account".into(),
                columns: vec!["tenant_id".into(), "account_id".into()],
                target: "account".into(),
                target_columns: vec!["tenant_id".into(), "id".into()],
                on_delete: "cascade".into(),
            }],
            ..Default::default()
        },
    ];
    let source = live::render_mermaid(&tables, None);
    assert!(source.contains(": (tenant_id, account_id) (") && source.contains(") cascade"), "{source}");
    let m = schema::build(&[schema::parse(&source).unwrap()]).unwrap();
    let rel = m.entities["membership"].relations.values().find(|r| r.target == "account").expect("relation");
    assert_eq!(rel.on_delete, "cascade");
    assert_eq!(rel.keys, vec![RelKey { local: "tenant_id".into(), target: "tenant_id".into() }, RelKey { local: "account_id".into(), target: "id".into() }]);
}

#[test]
fn sqlite_checks_and_postgres_index_names() {
    let checks = live::sqlite_checks(
        "probe",
        "CREATE TABLE probe (\n id INTEGER PRIMARY KEY,\n quantity INTEGER NOT NULL,\n label TEXT,\n CONSTRAINT positive_quantity CHECK (quantity >= 0),\n CHECK (length(label) <= 20)\n)",
    )
    .unwrap();
    assert_eq!(checks.len(), 2);
    assert_eq!((checks[0].name.as_str(), checks[0].expr.as_str()), ("positive_quantity", "quantity >= 0"));
    assert_eq!((checks[1].name.as_str(), checks[1].expr.as_str()), ("check_probe_2", "length(label) <= 20"));
    let table = Table { name: "probe".into(), columns: vec![column("id", "INTEGER", "PRI"), column("quantity", "INTEGER", "")], checks, ..Default::default() };
    let source = live::render_mermaid(&[table], None);
    assert!(source.contains("%% check probe positive_quantity : quantity >= 0"), "{source}");
    let err = live::sqlite_checks("probe", "CREATE TABLE probe (value INTEGER CHECK (value > 0").unwrap_err();
    assert!(err.contains("unbalanced"), "{err}");

    let definition = "CREATE INDEX item_ft_name_body ON public.item USING gin (to_tsvector('simple'::regconfig, (((COALESCE(name, ''::character varying))::text || ' '::text) || COALESCE(body, ''::text))))";
    assert_eq!(live::postgres_fulltext_columns(definition).unwrap(), vec!["name", "body"]);
    assert!(live::postgres_fulltext_columns("CREATE INDEX custom ON item USING gin (jsonb_path_ops(data))").is_err());
    assert_eq!(live::postgres_logical_index_name("migration_item", "migration_item_new_code_idx", false), "new_code_idx");
    assert_eq!(live::postgres_logical_index_name("migration_item", "uq_migration_item_code", true), "uq_migration_item_code");
}

#[test]
fn split_sql_respects_quotes_comments_and_dollar_bodies() {
    assert_eq!(
        split_sql("-- head\nSELECT 'a;b'; SELECT \"c;d\" /* ; */; SELECT $x$ ; $x$; SELECT `e;f`"),
        vec!["SELECT 'a;b'", "SELECT \"c;d\" /* ; */", "SELECT $x$ ; $x$", "SELECT `e;f`"]
    );
    assert_eq!(split_sql("SELECT 'it''s; fine'; ;\n-- only a comment\n"), vec!["SELECT 'it''s; fine'"]);
    assert!(split_sql("").is_empty());
}

#[test]
fn plan_files_define_ids_and_reject_tampering() {
    assert_eq!(plan_id("migrations/20260917-add-name.json", "").unwrap(), "20260917-add-name");
    for bad in ["add-name.json", "20260917-add-name.sql", "20261340-bad.json"] {
        assert!(plan_id(bad, "").unwrap_err().starts_with("MIGRATION_FILE_NAME"), "{bad}");
    }
    assert!(plan_id("20260917-a.json", "20260917-b").unwrap_err().contains("must match"));

    let from = schema::build(&[schema::parse("erDiagram\n  thing {\n    bigint id PK\n    varchar(20) name\n  }\n").unwrap()]).unwrap();
    let to = schema::build(&[schema::parse("erDiagram\n  thing {\n    bigint id PK\n  }\n").unwrap()]).unwrap();
    let plan = PlanFile::new("20260917-drop-name", "drop name", "postgres", from, to).unwrap();
    assert!(plan.rollback_data_loss_risk);
    plan.validate_rollback().unwrap();
    let parsed = PlanFile::parse(&plan.to_json()).unwrap();
    parsed.validate_rollback().unwrap();
    assert_eq!(parsed.to_json(), plan.to_json());

    let mut risk = parsed.clone();
    risk.rollback_data_loss_risk = false;
    assert!(risk.validate_rollback().unwrap_err().contains("rollback_data_loss_risk mismatch"));
    let mut flag = parsed.clone();
    flag.operations[0].destructive = !flag.operations[0].destructive;
    assert!(flag.validate_rollback().unwrap_err().contains("destructive flag mismatch"));
    let mut sql = parsed.clone();
    sql.operations[0].sql = "DROP TABLE thing;".into();
    assert!(sql.validate_rollback().unwrap_err().contains("checksum mismatch"));
    let mut embedded = parsed.clone();
    embedded.to_schema.as_mut().unwrap().entities.get_mut("thing").unwrap().table = "other".into();
    assert!(embedded.validate_rollback().unwrap_err().contains("invalid to_schema"));

    let ops = plan_operations("ALTER TABLE a ADD COLUMN b int; ALTER TABLE a DROP COLUMN c");
    assert_eq!((ops[0].destructive, ops[1].destructive), (false, true));
    assert_eq!(plan_sql(&ops), "ALTER TABLE a ADD COLUMN b int;\nALTER TABLE a DROP COLUMN c;\n");
}

#[test]
fn migration_logs_name_files_by_start_and_match_records() {
    let record = Record {
        migration_id: "m/1".into(),
        name: "n".into(),
        from_hash: "a".into(),
        to_hash: "b".into(),
        checksum: "c".into(),
        status: "applied".into(),
        operations: 2,
    };
    let log = Log::from_record(&record, "sqlite", "2026-09-17T01:02:03.5Z", "");
    assert_eq!(orm_build::migration::log_file_name(&log), "20260917T010203.5Z__m_1.json");
    let text = log.to_json();
    assert!(!text.contains("finished_at") && !text.contains("error_detail"), "{text}");
    let parsed: Log = serde_json::from_str(&text).unwrap();
    assert!(parsed.matches(&record, "sqlite"));
    assert!(!parsed.matches(&record, "mysql"));
    assert!(!parsed.matches(&Record { operations: 3, ..record.clone() }, "sqlite"));
    let at = std::time::UNIX_EPOCH + std::time::Duration::new(1_789_606_923, 120_000_000);
    assert_eq!(orm_build::migration::rfc3339_nano(at), "2026-09-17T01:02:03.12Z");
}

#[test]
fn sqlite_introspection_reads_generated_keys_and_clock_defaults() {
    let create = "CREATE TABLE \"kept\" (\n  \"id\" INTEGER PRIMARY KEY AUTOINCREMENT,\n  \"name\" TEXT NOT NULL\n)";
    assert!(live::sqlite_auto_increment(create, "id"));
    assert!(!live::sqlite_auto_increment(create, "name"));
    assert!(live::sqlite_auto_increment("CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT)", "ID"));
    assert!(!live::sqlite_auto_increment("CREATE TABLE t (\"id\" INTEGER PRIMARY KEY)", "id"));
    assert!(live::sqlite_clock_default("(strftime('%Y-%m-%d %H:%M:%f', 'now') || '000')"));
    assert!(live::sqlite_clock_default("CURRENT_TIMESTAMP"));
    assert!(!live::sqlite_clock_default("'now'"));
}

#[test]
fn diff_adds_commented_columns_and_ignores_sqlite_fulltext() {
    let base = Manifest::load(
        &schema::build(&[schema::parse(
            "erDiagram\n  note {\n    bigint id PK\n    varchar(64) title\n    text body \"?\"\n  }\n  %% fulltext note (title, body)\n",
        )
        .unwrap()])
        .unwrap()
        .marshal_indent(),
    )
    .unwrap();
    let next = schema::build(&[schema::parse(
        "erDiagram\n  note {\n    bigint id PK\n    varchar(32) tag \"?\"\n    varchar(64) title\n    text body \"?\"\n  }\n  %% column_comment note tag \"label\"\n",
    )
    .unwrap()])
    .unwrap();
    let mysql = render_diff(&base, &next, "mysql", true).unwrap();
    assert!(mysql.contains("ALTER TABLE `note` ADD COLUMN `tag` varchar(32) COMMENT 'label';"), "{mysql}");
    let postgres = render_diff(&base, &next, "postgres", true).unwrap();
    assert!(postgres.contains("COMMENT ON COLUMN \"note\".\"tag\" IS 'label';"), "{postgres}");
    let sqlite = render_diff(&base, &next, "sqlite", false).unwrap();
    assert!(!sqlite.contains("__orm_rebuild_") && sqlite.contains("orm_schema_comments"), "{sqlite}");
}
