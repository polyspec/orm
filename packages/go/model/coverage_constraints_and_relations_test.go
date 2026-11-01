//go:build featurecoverage

package model_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"

	"github.com/polyspec/orm/packages/go/engine/runtimemodel"
	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

type refusedRowModel struct {
	core   *orm.Core
	seq    int64
	amount int32
}

func (m *refusedRowModel) Orm_() *orm.Core { return m.core }

func refusedRowModelFrom(value orm.Model) (*refusedRowModel, error) {
	m, ok := value.(*refusedRowModel)
	if !ok || m == nil {
		return nil, fmt.Errorf("refused_row entity received model %T", value)
	}
	return m, nil
}

func refusedRowEntity(schema *orm.Schema) *orm.Entity {
	e := &orm.Entity{Name: "refused_row", Schema: schema}
	e.New = func(core *orm.Core) orm.Model {
		m := &refusedRowModel{core: core}
		core.Bind(m)
		return m
	}
	e.Assign = func(value orm.Model, name string, raw any) (bool, error) {
		m, err := refusedRowModelFrom(value)
		if err != nil {
			return false, err
		}
		switch name {
		case "seq":
			v, err := orm.AsInt64(raw)
			m.seq = v
			return true, err
		case "amount":
			v, err := orm.AsInt32(raw)
			m.amount = v
			return true, err
		default:
			return false, nil
		}
	}
	e.Value = func(value orm.Model, name string) (any, bool) {
		m, err := refusedRowModelFrom(value)
		if err != nil {
			panic(err)
		}
		switch name {
		case "seq":
			return m.seq, true
		case "amount":
			return m.amount, true
		default:
			return nil, false
		}
	}
	return e
}

// TestCoverageImmutableWrite verifies that a native trigger refusal preserves the row and its driver cause.
// DBS-84: renderer-installed immutable write triggers reject updates without changing stored rows.
// FCV-2: immutability is asserted through the driver error chain (errors.Unwrap and its equivalents), which is
// runtime-specific; the catalog write refuses triggered tables on MySQL by design (ROW_MUTATION_UNSUPPORTED).
func TestCoverageImmutableWrite(t *testing.T) {
	testcase.Start(t, testcase.Database)
	db, driver, dsn := connectFeature(t)
	text, err := os.ReadFile("../../../contracts/fixtures/refusal.dbs")
	if err != nil {
		t.Fatal(err)
	}
	runtime, diagnostics := runtimemodel.LoadDocuments([]string{string(text)})
	if len(diagnostics) != 0 {
		t.Fatal(runtimemodel.DiagnosticsError(diagnostics))
	}
	schema := &orm.Schema{Hash: runtime.ManifestHash, Text: runtime.ManifestText}
	entity := refusedRowEntity(schema)
	if nativeTableExists(t, driver, dsn, "refused_row") {
		t.Fatal("refused_row exists before the case")
	}
	raw := openNative(t, driver, dsn)
	t.Cleanup(func() {
		if _, err := raw.ExecContext(context.Background(), "DROP TABLE IF EXISTS refused_row"); err != nil {
			t.Error(err)
		}
		if driver == "postgres" {
			for _, name := range []string{"refused_row$immutable_update", "refused_row$immutable_delete"} {
				if _, err := raw.ExecContext(context.Background(), "DROP FUNCTION IF EXISTS \""+name+"\"()"); err != nil {
					t.Error(err)
				}
			}
		}
		if err := raw.Close(); err != nil {
			t.Error(err)
		}
	})
	if err := db.Utils().Schema().Install(schema); err != nil {
		t.Fatalf("install immutable fixture: %v", err)
	}
	created := must(refusedRowModelFrom(entity.New(orm.NewCore(entity))))
	created.core.Connect(db)
	created.core.Set("amount", int32(1))
	inserted := must(refusedRowModelFrom(must(created.core.Create())))
	query := must(refusedRowModelFrom(entity.New(orm.NewCore(entity))))
	query.core.Connect(db)
	query.core.Where("", []orm.ChainKey{{Column: "seq"}}, inserted.seq)
	row := must(refusedRowModelFrom(must(query.core.Get())))
	row.core.Set("amount", int32(2))
	err = row.core.Update(nil)
	if orm.ErrorCode(err) != orm.CodeDriver {
		t.Fatalf("immutable update = %v, want DRIVER", err)
	}
	if errors.Unwrap(err) == nil {
		t.Fatalf("immutable update lost its driver cause: %v", err)
	}
	check := must(refusedRowModelFrom(entity.New(orm.NewCore(entity))))
	check.core.Connect(db)
	check.core.Where("", []orm.ChainKey{{Column: "seq"}}, inserted.seq)
	stored := must(refusedRowModelFrom(must(check.core.Get())))
	if stored.amount != 1 {
		t.Fatalf("refused update changed amount from 1 to %d", stored.amount)
	}
}
