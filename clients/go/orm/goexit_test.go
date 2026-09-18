package orm_test

import (
	"encoding/json"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/polyspec/orm/clients/go/orm"
	"github.com/polyspec/orm/engine"
	"github.com/polyspec/orm/engine/schema"
)

// TestTransactionRollsBackWhenTheCallbackLeaves checks a callback that ends
// its goroutine instead of returning, which is what t.Fatal does: the
// transaction rolls back and the connection serves the next statement.
func TestTransactionRollsBackWhenTheCallbackLeaves(t *testing.T) {
	d, err := schema.Parse(zoneSchema)
	if err != nil {
		t.Fatal(err)
	}
	m, err := schema.Build(d)
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	eng, err := engine.New(m, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	db, err := orm.Open("sqlite://"+filepath.Join(t.TempDir(), "goexit.sqlite"), eng, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := db.Utils().Schema().Install(manifest); err != nil {
		t.Fatal(err)
	}
	ent := zoneEntity(m.SchemaHash)
	row := func() *orm.Core {
		c := orm.NewCore(ent)
		ent.New(c)
		c.Connect(db)
		return c
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		// The inner goroutine leaves through runtime.Goexit, as t.Fatal does.
		_ = db.Transaction(func() error {
			c := row()
			c.Set("start_dt", time.Now())
			if _, err := c.Create(); err != nil {
				return err
			}
			runtimeGoexit()
			return nil
		}, orm.Retry(0))
	}()
	<-done
	count, err := row().GetCount()
	if err != nil {
		t.Fatalf("read after the abandoned transaction: %v", err)
	}
	if count != 0 {
		t.Fatalf("rows after the abandoned transaction: %d", count)
	}
	c := row()
	c.Set("start_dt", time.Now())
	if _, err := c.Create(); err != nil {
		t.Fatalf("write after the abandoned transaction: %v", err)
	}
}

func runtimeGoexit() { runtime.Goexit() }
