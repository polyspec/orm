package orm_test

import (
	"context"
	"testing"

	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

// auditSource is the audit source that supplies the actor as the audit value. From the context
// it uses the actorKey value if present.
func auditSource(actor string) func(context.Context) (map[string]any, error) {
	return func(ctx context.Context) (map[string]any, error) {
		if v, ok := ctx.Value(actorKey{}).(string); ok {
			return map[string]any{"actor": v}, nil
		}
		return map[string]any{"actor": actor}, nil
	}
}

// actorKey is the key of the context value that the audit source reads.
type actorKey struct{}

// auditConfig is the connection setting that supplies the actor as the audit value.
func auditConfig(actor string) orm.Config { return orm.Config{AuditSource: auditSource(actor)} }

// TestAuditSourceReceivesTheTransactionContext checks that the audit source is called with the context of the transaction
// of a WithContext handle. It stays native (FCV-2): only the Go audit source takes a context (CFG-8); the audit behaviour
// that every runtime has is the recipe contracts/fixtures/audit_triggers/audit_triggers.json.
// Requirements: CFG-8a.
func TestAuditSourceReceivesTheTransactionContext(t *testing.T) {
	testcase.Start(t, testcase.Database)
	dsn := newDatabase(t, "sqlite")
	s := fixtureSchema(t, "audit")
	db := auditDB(t, dsn, s)
	items := rowEntity("item", s, "seq", "title", "audit_seq", "deleted_at")
	handle := db.WithContext(context.WithValue(context.Background(), actorKey{}, "context"))
	if err := handle.Transaction(func() error {
		c := orm.NewCore(items)
		c.Connect(handle)
		c.Set("title", "first")
		_, err := c.Create()
		return err
	}, orm.Audit(nil), orm.Retry(0)); err != nil {
		t.Fatal(err)
	}
	raw := openNativeSQLite(t, "sqlite", dsn, "")
	defer testcase.Close(t, raw)
	rows, err := raw.Query("SELECT actor FROM audit ORDER BY seq")
	if err != nil {
		t.Fatal(err)
	}
	defer testcase.Close(t, rows)
	var actors []string
	for rows.Next() {
		var actor string
		if err := rows.Scan(&actor); err != nil {
			t.Fatal(err)
		}
		actors = append(actors, actor)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(actors) != 1 || actors[0] != "context" {
		t.Fatalf("audit records = %v, want [context]", actors)
	}
}
