package orm_test

import (
	"context"
	"slices"
	"strings"
	"testing"

	"github.com/polyspec/orm/clients/go/orm"
	"github.com/polyspec/orm/internal/testcase"
)

// externalCase는 외부 문서를 쓰는 set을 dsn의 database에서 확인한다
// (contracts/fixtures/external). member set은 ext_core의 ext_account와 ext_audit을
// use로 쓰고 ext_post와 ext_post_history만 소유한다.
//   - 외부 table이 없으면 connect, install, addTablesAndColumns가 어떤 statement보다
//     먼저 CONFIG이고 member의 table을 만들지 않는다.
//   - core를 설치한 뒤 member install은 소유한 table만 만들고, 다시 하면 아무것도
//     바꾸지 않는다. addTablesAndColumns는 소유한 table에만 column을 더한다.
//   - member의 audit transaction은 core가 소유한 ext_audit에 기록을 삽입한다.
//   - 외부 문서의 쓰는 table이 database와 다르면(없는 column) CONFIG다.
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
	_, err := orm.ConnectSchema(dsn, member, config)
	expectConfig("connect before core", err, missing)

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
	// exists는 table이 있는지 raw 연결의 count로 확인한다.
	exists := func(table string) bool {
		var n int
		return raw.QueryRow("SELECT COUNT(*) FROM "+table).Scan(&n) == nil
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

	// board는 같은 core를 쓰는 다른 module set이다. schema 값으로만 등록된 set이 있어도
	// audit 기록 table은 그것을 소유한 core에서 찾는다.
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
	_, err = orm.ConnectSchema(dsn, drifted, config)
	expectConfig("connect with a drifted external table", err, differs)
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
