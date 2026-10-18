package orm_test

import (
	"context"
	"slices"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

// externalCase checks, on the database at dsn, a set that writes external documents
// (contracts/fixtures/external). The member set uses ext_account and ext_audit of ext_core through
// use, and owns only ext_post and ext_post_history.
//   - If an external table is missing, install and addTablesAndColumns fail with CONFIG before any statement,
//     and do not create the member's tables. Registration does not read the database, so
//     ConnectSchema connects even when the external tables are missing or differ.
//   - After core is installed, member install creates only the tables it owns, and running it again changes nothing.
//     addTablesAndColumns adds columns only to the tables it owns.
//   - The member's audit transaction inserts the record into ext_audit, which core owns.
//   - If a table that an external document writes differs from the database (a missing column), it is CONFIG.
func externalCase(t *testing.T, driver, dsn string) {
	t.Helper()
	core := fixtureSchema(t, "external/core")
	member := externalSchema(t, []string{"external/member"}, []string{"external/core"})
	memberV2 := externalSchema(t, []string{"external/member_v2"}, []string{"external/core"})
	drifted := externalSchema(t, []string{"external/member"}, []string{"external/core_extra"})
	config := orm.Config{AuditSource: func(context.Context) (map[string]any, error) { return map[string]any{"actor": "writer"}, nil }}
	expectConfig := func(step string, err error, message string) {
		t.Helper()
		if orm.ErrorCode(err) != orm.CodeConfig || !strings.Contains(err.Error(), message) {
			t.Fatalf("%s: %v, want CONFIG with %q", step, err, message)
		}
	}
	missing := "the tables that the set uses from external documents differ from the database: table ext_account does not exist; table ext_audit does not exist"
	before, err := orm.ConnectSchema(dsn, member, config)
	if err != nil {
		t.Fatalf("connect before core: %v, want a connection that reads nothing", err)
	}
	if err := before.Close(); err != nil {
		t.Fatal(err)
	}

	db, err := orm.Connect(dsn, config)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	}()
	schema := db.Utils().Schema()
	raw := restoreNative(t, driver, dsn)
	defer raw.Close()
	// exists checks with the raw connection's catalog whether a table exists. A failure that reads a missing table
	// is not used with a transaction pooler (PgBouncer), since it leaves named prepared statements behind.
	exists := func(table string) bool {
		query := map[string]string{
			"mysql":    "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '" + table + "'",
			"postgres": "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = '" + table + "'",
			"sqlite":   "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = '" + table + "'",
		}[driver]
		var n int
		if err := raw.QueryRow(query).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n == 1
	}
	expectConfig("install before core", schema.Install(member), missing)
	_, err = schema.AddTablesAndColumns(member)
	expectConfig("addTablesAndColumns before core", err, missing)
	if exists("ext_post") {
		t.Fatal("ext_post exists after the refused install")
	}

	if err := schema.Install(core); err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec("INSERT INTO ext_account (name) VALUES ('kim')"); err != nil {
		t.Fatal(err)
	}
	for i := range 2 {
		if err := schema.Install(member); err != nil {
			t.Fatalf("install %d of member: %v", i+1, err)
		}
	}
	for _, table := range []string{"ext_post", "ext_post_history"} {
		if !exists(table) {
			t.Fatalf("%s does not exist after the member install", table)
		}
	}
	connected, err := orm.ConnectSchema(dsn, member, config)
	if err != nil {
		t.Fatalf("connect with core installed: %v", err)
	}
	if err := connected.Close(); err != nil {
		t.Fatal(err)
	}

	// board is another module set that uses the same core. Even when a set is registered only as a schema value,
	// its audit record table is found in the core that owns it.
	board := externalSchema(t, []string{"external/board"}, []string{"external/core"})
	if err := schema.Install(board); err != nil {
		t.Fatalf("install of board: %v", err)
	}
	posts := rowEntity("ext_post", member, "seq", "account_seq", "title", "audit_seq")
	err = db.Transaction(func() error {
		c := orm.NewCore(posts)
		c.Connect(db)
		c.Set("account_seq", int64(1))
		c.Set("title", "hello")
		_, err := c.Create()
		return err
	}, orm.Audit(map[string]any{}))
	if err != nil {
		t.Fatalf("audited create in the member set: %v", err)
	}
	var actor string
	var audit, recorded int64
	if err := raw.QueryRow("SELECT seq, actor FROM ext_audit").Scan(&audit, &actor); err != nil {
		t.Fatal(err)
	}
	if err := raw.QueryRow("SELECT audit_seq FROM ext_post_history").Scan(&recorded); err != nil {
		t.Fatal(err)
	}
	if actor != "writer" || recorded != audit {
		t.Fatalf("audit record (%d, %q) and history audit %d, want the record of writer in the history", audit, actor, recorded)
	}

	added, err := schema.AddTablesAndColumns(member)
	if err != nil || len(added) != 0 {
		t.Fatalf("addTablesAndColumns of the installed member: %v %v, want nothing", added, err)
	}
	added, err = schema.AddTablesAndColumns(memberV2)
	if err != nil || !slices.Equal(added, []string{"ext_post.summary", "ext_post_history.summary"}) {
		t.Fatalf("addTablesAndColumns of member_v2: %v %v", added, err)
	}
	var accounts int
	if err := raw.QueryRow("SELECT COUNT(*) FROM ext_account").Scan(&accounts); err != nil || accounts != 1 {
		t.Fatalf("ext_account has %d rows (%v) after the member changes, want 1", accounts, err)
	}

	differs := "the tables that the set uses from external documents differ from the database: column ext_account.nick does not exist"
	connected, err = orm.ConnectSchema(dsn, drifted, config)
	if err != nil {
		t.Fatalf("connect with a drifted external table: %v, want a connection that reads nothing", err)
	}
	if err := connected.Close(); err != nil {
		t.Fatal(err)
	}
	expectConfig("install with a drifted external table", schema.Install(drifted), differs)
	_, err = schema.AddTablesAndColumns(drifted)
	expectConfig("addTablesAndColumns with a drifted external table", err, differs)
}

func TestExternalDocuments(t *testing.T) {
	testcase.Start(t, testcase.Database)
	for _, driver := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(driver, func(t *testing.T) { externalCase(t, driver, newDatabase(t, driver)) })
	}
}
