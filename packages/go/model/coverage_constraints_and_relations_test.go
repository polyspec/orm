//go:build featurecoverage

package model_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"slices"
	"testing"

	"github.com/polyspec/orm/packages/go/engine/runtimemodel"
	"github.com/polyspec/orm/packages/go/model"
	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

// TestCoverageConstraintErrors checks that a foreign key, check, and unique violation against a seed row
// yield FOREIGN_KEY, CONSTRAINT, and DUPLICATE_KEY respectively, and
// that no row changes.
// CFG-33: database constraints map to stable error codes and leave rejected rows unchanged.
func TestCoverageConstraintErrors(t *testing.T) {
	testcase.Start(t, testcase.Database)
	db, _, _ := connectFeature(t)
	user := must(model.User().Connect(db).Seq(1).Get())
	if err := user.Delete(); orm.ErrorCode(err) != orm.CodeForeignKey {
		t.Fatalf("delete of a referenced user = %v, want FOREIGN_KEY", err)
	}
	if got := readColumn(t, must(model.User().Connect(db).Seq(1).Get()).GetName); got != "user-1" {
		t.Fatalf("user 1 name = %q after the rejected delete", got)
	}

	first := must(model.Author().Connect(db).GetBySeq(1))
	second := must(model.Author().Connect(db).GetBySeq(2))
	likes, uuid := readColumn(t, first.GetLikeCount), readColumn(t, first.GetUuid)
	if uuid == nil || readColumn(t, second.GetUuid) == nil || *uuid == *readColumn(t, second.GetUuid) {
		t.Fatalf("seed uuids of author 1 and 2 are not distinct values: %v %v", uuid, readColumn(t, second.GetUuid))
	}
	if _, err := must(model.Author().Connect(db).GetBySeq(1)).SetLikeCount(-1).Update(); orm.ErrorCode(err) != orm.CodeConstraint {
		t.Fatalf("negative like_count = %v, want CONSTRAINT", err)
	}
	if _, err := must(model.Author().Connect(db).GetBySeq(1)).SetUuid(readColumn(t, second.GetUuid)).Update(); orm.ErrorCode(err) != orm.CodeDuplicateKey {
		t.Fatalf("duplicate uuid = %v, want DUPLICATE_KEY", err)
	}
	after := must(model.Author().Connect(db).GetBySeq(1))
	if readColumn(t, after.GetLikeCount) != likes || readColumn(t, after.GetUuid) == nil || *readColumn(t, after.GetUuid) != *uuid ||
		!readColumn(t, after.GetUpdatedTs).Equal(readColumn(t, first.GetUpdatedTs)) {
		t.Fatalf("author 1 changed: like_count %d uuid %v updated_ts %v", readColumn(t, after.GetLikeCount), readColumn(t, after.GetUuid), readColumn(t, after.GetUpdatedTs))
	}
}

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

// TestCoverageExternalRelation follows note_reader to shared_note, a table from an external document.
func TestCoverageExternalRelation(t *testing.T) {
	testcase.Start(t, testcase.Database)
	db, _, _ := connectFeature(t)
	rows := must(model.NoteReader().Connect(db).
		Relation(model.SharedNote().MatchSharedNoteSeqWithSeq()).
		OrderBySeqAsc().Gets())
	var got []string
	for _, row := range rows.Slice() {
		note := must(row.GetSharedNoteModel())
		got = append(got, fmt.Sprintf("%d:%s", readColumn(t, row.GetSeq), readColumn(t, note.GetTitle)))
	}
	if want := []string{"1:note-1", "2:note-1", "3:note-3"}; !slices.Equal(got, want) {
		t.Fatalf("external shared_note relation = %q, want %q", got, want)
	}
}

// TestCoverageImmutableWrite verifies that a native trigger refusal preserves the row and its driver cause.
// DBS-84: renderer-installed immutable write triggers reject updates without changing stored rows.
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
