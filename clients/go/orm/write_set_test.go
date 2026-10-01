package orm_test

import (
	"errors"
	"fmt"
	"path/filepath"
	"testing"

	"github.com/polyspec/orm/clients/go/orm"
)

func TestWasInsertedTracksGeneratedRows(t *testing.T) {
	s := documentSchema(t, "dbspec 1 write_set\n\ntable record {\n  seq i64 identity\n  label varchar(32)\n  primary key (seq)\n}\n")
	db, err := orm.Connect("sqlite://"+filepath.Join(t.TempDir(), "write-set.sqlite"), s, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	waiting, err := db.BackendWaitingForLock(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if waiting {
		t.Fatal("SQLite reported a PostgreSQL backend lock wait")
	}
	if err := db.Utils().Schema().Install(s.Text); err != nil {
		t.Fatal(err)
	}
	records := rowEntity("record", s, "seq", "label")
	if err := db.Transaction(func() error {
		c := orm.NewCore(records)
		c.Set("label", "outer")
		created, err := c.Create()
		if err != nil {
			return err
		}
		seq := created.(*keywordRow).vals["seq"].(int64)
		inserted, err := db.Utils().WasInserted("record", seq)
		if err != nil || !inserted {
			return fmt.Errorf("outer insert was not recorded: inserted=%v err=%v", inserted, err)
		}
		var nestedSeq int64
		err = db.Transaction(func() error {
			inner := orm.NewCore(records)
			inner.Set("label", "nested")
			row, createErr := inner.Create()
			if createErr != nil {
				return createErr
			}
			nestedSeq = row.(*keywordRow).vals["seq"].(int64)
			ok, checkErr := db.Utils().WasInserted("record", nestedSeq)
			if checkErr != nil || !ok {
				return fmt.Errorf("nested insert was not recorded: inserted=%v err=%v", ok, checkErr)
			}
			return errors.New("rollback nested savepoint")
		}, orm.Retry(0))
		if err == nil {
			return errors.New("nested transaction unexpectedly committed")
		}
		ok, checkErr := db.Utils().WasInserted("record", nestedSeq)
		if checkErr != nil {
			return checkErr
		}
		if ok {
			return errors.New("nested insert remained in the write set after savepoint rollback")
		}
		return nil
	}, orm.Retry(0)); err != nil {
		t.Fatal(err)
	}
}
