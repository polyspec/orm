package main

import (
	"strings"
	"testing"

	"github.com/polyspec/orm/engine/schema"
)

func testManifest(columns ...*schema.Col) *schema.Manifest {
	e := &schema.Entity{Name: "thing", Table: "thing", PK: []string{"id"}, Columns: columns}
	return &schema.Manifest{SchemaHash: "test", Order: []string{"thing"}, Entities: map[string]*schema.Entity{"thing": e}}
}

func TestRenderDiffAddColumnIsSafe(t *testing.T) {
	old := testManifest(&schema.Col{Name: "id", Type: "i64", Raw: "bigint", PK: true})
	now := testManifest(&schema.Col{Name: "id", Type: "i64", Raw: "bigint", PK: true}, &schema.Col{Name: "name", Type: "string", Raw: "varchar(20)"})
	sql, err := renderDiff(old, now, "mysql", false)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(sql, "ALTER TABLE `thing` ADD COLUMN `name` varchar(20) NOT NULL;") {
		t.Fatalf("unexpected migration: %s", sql)
	}
}

func TestRenderDiffRejectsDestructiveChange(t *testing.T) {
	old := testManifest(&schema.Col{Name: "id", Type: "i64", Raw: "bigint", PK: true}, &schema.Col{Name: "name", Type: "string", Raw: "varchar(20)"})
	now := testManifest(&schema.Col{Name: "id", Type: "i64", Raw: "bigint", PK: true})
	if _, err := renderDiff(old, now, "mysql", false); err == nil || !strings.Contains(err.Error(), "--allow-destructive") {
		t.Fatalf("expected destructive-change error, got %v", err)
	}
	sql, err := renderDiff(old, now, "mysql", true)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(sql, "DROP COLUMN `name`") {
		t.Fatalf("unexpected migration: %s", sql)
	}
}

func TestRenderDiffIsDeterministic(t *testing.T) {
	old := testManifest(&schema.Col{Name: "id", Type: "i64", Raw: "bigint", PK: true})
	now := testManifest(&schema.Col{Name: "id", Type: "i64", Raw: "bigint", PK: true}, &schema.Col{Name: "z", Type: "string", Raw: "text"}, &schema.Col{Name: "a", Type: "string", Raw: "text"})
	a, err := renderDiff(old, now, "postgres", false)
	if err != nil {
		t.Fatal(err)
	}
	b, err := renderDiff(old, now, "postgres", false)
	if err != nil {
		t.Fatal(err)
	}
	if a != b {
		t.Fatal("migration output is not deterministic")
	}
}

func TestRenderDiffAddsAndDropsIndexesAndConstraints(t *testing.T) {
	old := testManifest(
		&schema.Col{Name: "id", Type: "i64", Raw: "bigint", PK: true},
		&schema.Col{Name: "old_code", Type: "string", Raw: "varchar(20)"},
		&schema.Col{Name: "body", Type: "text", Raw: "text", Nullable: true},
	)
	old.Entities["thing"].Indexes = map[string][]string{"old_code_idx": {"old_code"}}
	old.Entities["thing"].Unique = [][]string{{"old_code"}}
	old.Entities["thing"].Fulltext = [][]string{{"body"}}

	now := testManifest(
		&schema.Col{Name: "id", Type: "i64", Raw: "bigint", PK: true},
		&schema.Col{Name: "old_code", Type: "string", Raw: "varchar(20)"},
		&schema.Col{Name: "body", Type: "text", Raw: "text", Nullable: true},
	)
	now.Entities["thing"].Indexes = map[string][]string{"body_idx": {"body"}}
	now.Entities["thing"].Unique = [][]string{{"id", "old_code"}}
	now.Entities["thing"].Fulltext = [][]string{{"old_code", "body"}}

	sql, err := renderDiff(old, now, "mysql", true)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"DROP INDEX `old_code_idx` ON `thing`;",
		"DROP INDEX `uq_thing_old_code` ON `thing`;",
		"DROP INDEX `ft_body` ON `thing`;",
		"CREATE INDEX `body_idx` ON `thing` (`body`);",
		"CREATE UNIQUE INDEX `uq_thing_id_old_code` ON `thing` (`id`, `old_code`);",
		"CREATE FULLTEXT INDEX `ft_old_code_body` ON `thing` (`old_code`, `body`);",
	} {
		if !strings.Contains(sql, want) {
			t.Errorf("migration missing %q:\n%s", want, sql)
		}
	}
}

func TestRenderDiffPostgresEmitsTypeNullabilityAndDefaultChanges(t *testing.T) {
	oldDefault := "draft"
	newDefault := "published"
	old := testManifest(
		&schema.Col{Name: "id", Type: "i64", Raw: "bigint", PK: true},
		&schema.Col{Name: "status", Type: "string", Raw: "varchar(20)", Len: 20, Nullable: true, Default: &oldDefault},
	)
	now := testManifest(
		&schema.Col{Name: "id", Type: "i64", Raw: "bigint", PK: true},
		&schema.Col{Name: "status", Type: "string", Raw: "varchar(40)", Len: 40, Nullable: false, Default: &newDefault},
	)

	sql, err := renderDiff(old, now, "postgres", true)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`ALTER TABLE "thing" ALTER COLUMN "status" TYPE varchar(40);`,
		`ALTER TABLE "thing" ALTER COLUMN "status" SET NOT NULL;`,
		`ALTER TABLE "thing" ALTER COLUMN "status" SET DEFAULT 'published';`,
	} {
		if !strings.Contains(sql, want) {
			t.Errorf("migration missing %q:\n%s", want, sql)
		}
	}
}

func TestRenderDDLIncludesForeignKeysAndDeleteActions(t *testing.T) {
	parent := &schema.Entity{
		Name: "account", Table: "account", PK: []string{"id"}, Relations: map[string]*schema.Rel{},
		Columns: []*schema.Col{{Name: "id", Type: "i64", Raw: "bigint", PK: true}},
	}
	child := &schema.Entity{
		Name: "thing", Table: "thing", PK: []string{"id"},
		Columns: []*schema.Col{
			{Name: "id", Type: "i64", Raw: "bigint", PK: true},
			{Name: "account_id", Type: "i64", Raw: "bigint", FK: true, Ref: &schema.Ref{Entity: "account", Column: "id"}},
		},
		Relations: map[string]*schema.Rel{
			"account": {Name: "account", Kind: "one", Target: "account", Keys: []schema.RelKey{{Local: "account_id", Target: "id"}}, OnDelete: "cascade"},
		},
	}
	m := &schema.Manifest{SchemaHash: "test", Order: []string{"account", "thing"}, Entities: map[string]*schema.Entity{"account": parent, "thing": child}}
	fk := entityForeignKeys(m, child)["account_id"]
	if fk.onDelete != "cascade" {
		t.Fatalf("foreign key delete action=%q; foreign key=%#v", fk.onDelete, fk)
	}

	for _, tc := range []struct {
		dialect string
		want    string
	}{
		{"mysql", "CONSTRAINT `fk_thing_account_id` FOREIGN KEY (`account_id`) REFERENCES `account` (`id`) ON DELETE CASCADE"},
		{"postgres", `CONSTRAINT "fk_thing_account_id" FOREIGN KEY ("account_id") REFERENCES "account" ("id") ON DELETE CASCADE`},
		{"sqlite", `CONSTRAINT "fk_thing_account_id" FOREIGN KEY ("account_id") REFERENCES "account" ("id") ON DELETE CASCADE`},
	} {
		sql, err := renderDDL(m, tc.dialect)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(sql, tc.want) {
			t.Errorf("%s DDL missing %q:\n%s", tc.dialect, tc.want, sql)
		}
	}
}

func TestRenderDDLAndDiffPreserveChecks(t *testing.T) {
	m := testManifest(&schema.Col{Name: "id", Type: "i64", Raw: "bigint", PK: true}, &schema.Col{Name: "quantity", Type: "i32", Raw: "int"})
	m.Entities["thing"].Checks = []schema.Check{{Name: "positive_quantity", Expr: "`quantity` >= 0"}}
	ddl, err := renderDDL(m, "mysql")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(ddl, "CONSTRAINT `positive_quantity` CHECK (`quantity` >= 0)") {
		t.Fatalf("DDL omitted CHECK: %s", ddl)
	}
	old := testManifest(&schema.Col{Name: "id", Type: "i64", Raw: "bigint", PK: true}, &schema.Col{Name: "quantity", Type: "i32", Raw: "int"})
	diff, err := renderDiff(old, m, "postgres", false)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(diff, "ADD CONSTRAINT \"positive_quantity\" CHECK (\"quantity\" >= 0);") {
		t.Fatalf("diff omitted CHECK: %s", diff)
	}
	old.Entities["thing"].Checks = append([]schema.Check(nil), m.Entities["thing"].Checks...)
	m.Entities["thing"].Checks[0].Expr = "`quantity` > 0"
	sqlite, err := renderDiff(old, m, "sqlite", true)
	if err != nil || !strings.Contains(sqlite, "CONSTRAINT \"positive_quantity\" CHECK (\"quantity\" > 0)") {
		t.Fatalf("SQLite CHECK rebuild missing: err=%v sql=%s", err, sqlite)
	}
}

func TestRenderDDLOrdersForeignKeyParentsBeforeChildrenAndDropsChildrenFirst(t *testing.T) {
	parent := &schema.Entity{Name: "parent", Table: "parent", PK: []string{"id"}, Relations: map[string]*schema.Rel{}, Columns: []*schema.Col{{Name: "id", Type: "i64", Raw: "bigint", PK: true}}}
	child := &schema.Entity{Name: "child", Table: "child", PK: []string{"id"}, Relations: map[string]*schema.Rel{}, Columns: []*schema.Col{
		{Name: "id", Type: "i64", Raw: "bigint", PK: true},
		{Name: "parent_id", Type: "i64", Raw: "bigint", Ref: &schema.Ref{Entity: "parent", Column: "id"}},
	}}
	m := &schema.Manifest{SchemaHash: "test", Order: []string{"child", "parent"}, Entities: map[string]*schema.Entity{"child": child, "parent": parent}}

	sql, err := renderDDL(m, "postgres")
	if err != nil {
		t.Fatal(err)
	}
	dropChild := strings.Index(sql, `DROP TABLE IF EXISTS "child"`)
	dropParent := strings.Index(sql, `DROP TABLE IF EXISTS "parent"`)
	createParent := strings.Index(sql, `CREATE TABLE "parent"`)
	createChild := strings.Index(sql, `CREATE TABLE "child"`)
	if dropChild < 0 || dropParent < 0 || createParent < 0 || createChild < 0 || !(dropChild < dropParent && dropParent < createParent && createParent < createChild) {
		t.Fatalf("invalid foreign-key DDL order:\n%s", sql)
	}
}

func TestRenderDDLOrdersNamedIndexes(t *testing.T) {
	m := testManifest(
		&schema.Col{Name: "id", Type: "i64", Raw: "bigint", PK: true},
		&schema.Col{Name: "a", Type: "string", Raw: "text"},
		&schema.Col{Name: "m", Type: "string", Raw: "text"},
		&schema.Col{Name: "z", Type: "string", Raw: "text"},
	)
	m.Entities["thing"].Indexes = map[string][]string{"z_idx": {"z"}, "a_idx": {"a"}, "m_idx": {"m"}}
	sql, err := renderDDL(m, "postgres")
	if err != nil {
		t.Fatal(err)
	}
	a := strings.Index(sql, `"thing_a_idx"`)
	middle := strings.Index(sql, `"thing_m_idx"`)
	z := strings.Index(sql, `"thing_z_idx"`)
	if a < 0 || middle < 0 || z < 0 || !(a < middle && middle < z) {
		t.Fatalf("indexes are not sorted:\n%s", sql)
	}
}

func TestRenderDiffChangesForeignKeyDeleteAction(t *testing.T) {
	manifest := func(action string) *schema.Manifest {
		parent := &schema.Entity{Name: "account", Table: "account", PK: []string{"id"}, Relations: map[string]*schema.Rel{}, Columns: []*schema.Col{{Name: "id", Type: "i64", Raw: "bigint", PK: true}}}
		child := &schema.Entity{
			Name: "thing", Table: "thing", PK: []string{"id"},
			Columns: []*schema.Col{
				{Name: "id", Type: "i64", Raw: "bigint", PK: true},
				{Name: "account_id", Type: "i64", Raw: "bigint", FK: true, Ref: &schema.Ref{Entity: "account", Column: "id"}},
			},
			Relations: map[string]*schema.Rel{"account": {Name: "account", Kind: "one", Target: "account", Keys: []schema.RelKey{{Local: "account_id", Target: "id"}}, OnDelete: action}},
		}
		return &schema.Manifest{SchemaHash: action, Order: []string{"account", "thing"}, Entities: map[string]*schema.Entity{"account": parent, "thing": child}}
	}

	sql, err := renderDiff(manifest(""), manifest("setnull"), "postgres", true)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`ALTER TABLE "thing" DROP CONSTRAINT "fk_thing_account_id";`,
		`ALTER TABLE "thing" ADD CONSTRAINT "fk_thing_account_id" FOREIGN KEY ("account_id") REFERENCES "account" ("id") ON DELETE SET NULL;`,
	} {
		if !strings.Contains(sql, want) {
			t.Errorf("migration missing %q:\n%s", want, sql)
		}
	}
}

func TestRenderDiffOrdersForeignKeysAndIndexesForMySQL(t *testing.T) {
	manifest := func(indexName string) *schema.Manifest {
		parent := &schema.Entity{Name: "account", Table: "account", PK: []string{"id"}, Relations: map[string]*schema.Rel{}, Columns: []*schema.Col{{Name: "id", Type: "i64", Raw: "bigint", PK: true}}}
		child := &schema.Entity{
			Name: "thing", Table: "thing", PK: []string{"id"}, Indexes: map[string][]string{indexName: {"account_id"}},
			Columns: []*schema.Col{
				{Name: "id", Type: "i64", Raw: "bigint", PK: true},
				{Name: "account_id", Type: "i64", Raw: "bigint", FK: true, Ref: &schema.Ref{Entity: "account", Column: "id"}},
			},
			Relations: map[string]*schema.Rel{"account": {Name: "account", Kind: "one", Target: "account", Keys: []schema.RelKey{{Local: "account_id", Target: "id"}}}},
		}
		return &schema.Manifest{SchemaHash: indexName, Order: []string{"account", "thing"}, Entities: map[string]*schema.Entity{"account": parent, "thing": child}}
	}
	old := manifest("old_account_idx")
	now := manifest("new_account_idx")
	now.Entities["thing"].Relations["account"].OnDelete = "cascade"

	sql, err := renderDiff(old, now, "mysql", true)
	if err != nil {
		t.Fatal(err)
	}
	positions := []int{
		strings.Index(sql, "DROP FOREIGN KEY"),
		strings.Index(sql, "DROP INDEX `old_account_idx`"),
		strings.Index(sql, "CREATE INDEX `new_account_idx`"),
		strings.Index(sql, "ADD CONSTRAINT `fk_thing_account_id`"),
	}
	for _, position := range positions {
		if position < 0 {
			t.Fatalf("missing ordered operation: %v\n%s", positions, sql)
		}
	}
	if !(positions[0] < positions[1] && positions[1] < positions[2] && positions[2] < positions[3]) {
		t.Fatalf("invalid operation order: %v\n%s", positions, sql)
	}
}

func TestRenderDiffUsesExplicitTableAndColumnRenames(t *testing.T) {
	old := &schema.Manifest{SchemaHash: "old", Order: []string{"account"}, Entities: map[string]*schema.Entity{
		"account": {Name: "account", Table: "account", PK: []string{"id"}, Columns: []*schema.Col{
			{Name: "id", Type: "i64", Raw: "bigint", PK: true},
			{Name: "name", Type: "string", Raw: "varchar(40)", Len: 40},
		}},
	}}
	now := &schema.Manifest{SchemaHash: "new", Order: []string{"customer"}, Entities: map[string]*schema.Entity{
		"customer": {Name: "customer", Table: "customer", RenamedFrom: "account", PK: []string{"id"}, Columns: []*schema.Col{
			{Name: "id", Type: "i64", Raw: "bigint", PK: true},
			{Name: "display_name", RenamedFrom: "name", Type: "string", Raw: "varchar(40)", Len: 40},
		}},
	}}
	forward, err := renderDiff(old, now, "postgres", false)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(forward, `ALTER TABLE "account" RENAME TO "customer";`) || !strings.Contains(forward, `ALTER TABLE "customer" RENAME COLUMN "name" TO "display_name";`) || strings.Contains(forward, "DROP TABLE") {
		t.Fatalf("invalid forward rename:\n%s", forward)
	}
	rollback, err := renderDiff(now, old, "postgres", false)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(rollback, `ALTER TABLE "customer" RENAME TO "account";`) || !strings.Contains(rollback, `ALTER TABLE "account" RENAME COLUMN "display_name" TO "name";`) {
		t.Fatalf("invalid rollback rename:\n%s", rollback)
	}
}

func TestRenderDiffDropsChildConstraintsBeforeTableRename(t *testing.T) {
	parent := func() *schema.Entity {
		return &schema.Entity{Name: "owner", Table: "owner", PK: []string{"id"}, Relations: map[string]*schema.Rel{}, Columns: []*schema.Col{{Name: "id", Type: "i64", Raw: "bigint", PK: true}}}
	}
	oldChild := &schema.Entity{Name: "entry", Table: "entry", PK: []string{"id"}, Indexes: map[string][]string{"owner_idx": {"owner_id"}}, Columns: []*schema.Col{
		{Name: "id", Type: "i64", Raw: "bigint", PK: true},
		{Name: "owner_id", Type: "i64", Raw: "bigint", Ref: &schema.Ref{Entity: "owner", Column: "id"}},
	}, Relations: map[string]*schema.Rel{"owner": {Name: "owner", Kind: "one", Target: "owner", Keys: []schema.RelKey{{Local: "owner_id", Target: "id"}}}}}
	newChild := &schema.Entity{Name: "record", Table: "record", RenamedFrom: "entry", PK: []string{"id"}, Indexes: map[string][]string{"owner_new_idx": {"owner_id"}}, Columns: oldChild.Columns, Relations: oldChild.Relations}
	old := &schema.Manifest{SchemaHash: "old", Order: []string{"owner", "entry"}, Entities: map[string]*schema.Entity{"owner": parent(), "entry": oldChild}}
	now := &schema.Manifest{SchemaHash: "new", Order: []string{"owner", "record"}, Entities: map[string]*schema.Entity{"owner": parent(), "record": newChild}}

	sql, err := renderDiff(old, now, "mysql", false)
	if err != nil {
		t.Fatal(err)
	}
	drop := strings.Index(sql, "DROP INDEX `owner_idx` ON `entry`")
	rename := strings.Index(sql, "ALTER TABLE `entry` RENAME TO `record`")
	add := strings.Index(sql, "CREATE INDEX `owner_new_idx` ON `record`")
	if drop < 0 || rename < 0 || add < 0 || !(drop < rename && rename < add) {
		t.Fatalf("invalid renamed-table operation order: drop=%d rename=%d add=%d\n%s", drop, rename, add, sql)
	}
}

func TestRenderDiffRejectsMissingRenameSource(t *testing.T) {
	old := testManifest(&schema.Col{Name: "id", Type: "i64", Raw: "bigint", PK: true})
	now := &schema.Manifest{SchemaHash: "new", Order: []string{"customer"}, Entities: map[string]*schema.Entity{
		"customer": {Name: "customer", Table: "customer", RenamedFrom: "missing", PK: []string{"id"}, Columns: []*schema.Col{{Name: "id", Type: "i64", Raw: "bigint", PK: true}}},
	}}
	if _, err := renderDiff(old, now, "postgres", true); err == nil || !strings.Contains(err.Error(), "rename source") {
		t.Fatalf("expected missing rename source error, got %v", err)
	}
}

func TestRenderDiffRenameMetadataIsIdempotentAfterApply(t *testing.T) {
	current := &schema.Manifest{SchemaHash: "current", Order: []string{"customer"}, Entities: map[string]*schema.Entity{
		"customer": {Name: "customer", Table: "customer", PK: []string{"id"}, Columns: []*schema.Col{
			{Name: "id", Type: "i64", Raw: "bigint", PK: true},
			{Name: "display_name", Type: "string", Raw: "varchar(40)", Len: 40},
		}},
	}}
	target := &schema.Manifest{SchemaHash: "target", Order: []string{"customer"}, Entities: map[string]*schema.Entity{
		"customer": {Name: "customer", Table: "customer", RenamedFrom: "account", PK: []string{"id"}, Columns: []*schema.Col{
			{Name: "id", Type: "i64", Raw: "bigint", PK: true},
			{Name: "display_name", RenamedFrom: "name", Type: "string", Raw: "varchar(40)", Len: 40},
		}},
	}}
	sql, err := renderDiff(current, target, "postgres", false)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(sql, "-- no changes") {
		t.Fatalf("rename metadata repeat is not a no-op:\n%s", sql)
	}
}
