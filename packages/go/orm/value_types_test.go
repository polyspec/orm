package orm_test

import (
	"testing"
	"time"

	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

const valueTypesDocument = `dbspec 1 value_types

table typed_value {
  seq i64 identity
  small i16
  wide i64
  ratio f64
  active bool
  ref uuid
  clock time(3)
  day date
  address bytes null
  packed bytes null
  payload text null
  note text
  primary key (seq)
  settings {
    codec address ip
    codec packed gz
    codec payload ordered_json
  }
}
`

// TestRuntimeValueTypes writes i16, uuid, time(p), date, and ip codec values,
// gz codec values, and a text column without select explicit in three databases, and reads them back as the Go value types of docs/spec/dbspec.md "Runtime
// model" Go value types.
// Requirements: INT-99, DBS-68, COD-20.
func TestRuntimeValueTypes(t *testing.T) {
	testcase.Start(t, testcase.Database)
	s := documentSchema(t, valueTypesDocument)
	columns := []string{"seq", "small", "wide", "ratio", "active", "ref", "clock", "day", "address", "packed", "payload", "note"}
	eachDatabase(t, []string{"sqlite", "mysql", "postgres"}, s, 1, func(t *testing.T, driver, dsn string, db *orm.DB) {
		ent := rowEntity("typed_value", s, columns...)
		c := orm.NewCore(ent)
		c.Connect(db)
		c.Set("small", int16(-1234))
		c.Set("wide", int64(7))
		c.Set("ratio", 1.25)
		c.Set("active", true)
		c.Set("ref", "0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e")
		c.Set("clock", "10:20:30.500")
		c.Set("day", "2026-02-03")
		c.Set("address", "192.0.2.7")
		c.Set("packed", orm.Value("compressed text"))
		c.Set("payload", orm.SqlNull())
		c.Set("note", "plain text")
		if _, err := c.Create(); err != nil {
			t.Fatal(err)
		}
		q := orm.NewCore(ent)
		q.Connect(db)
		row, err := q.Get()
		if err != nil {
			t.Fatal(err)
		}
		vals := as[*keywordRow](t, row).vals
		if v, err := orm.AsInt16(vals["small"]); err != nil || v != -1234 {
			t.Errorf("small = %#v (%v)", vals["small"], err)
		}
		if v, err := orm.AsString(vals["ref"]); err != nil || v != "0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e" {
			t.Errorf("ref = %#v (%v)", vals["ref"], err)
		}
		if v, err := orm.AsTimeText(vals["clock"], 3); err != nil || v != "10:20:30.500" {
			t.Errorf("clock = %#v (%v)", vals["clock"], err)
		}
		if v, ok := vals["day"].(time.Time); !ok || v.Format("2006-01-02") != "2026-02-03" {
			t.Errorf("day = %#v", vals["day"])
		}
		if v, err := orm.AsString(vals["address"]); err != nil || v != "192.0.2.7" {
			t.Errorf("address = %#v", vals["address"])
		}
		packed, ok := vals["packed"].(orm.StyledValue)
		if data, present := packed.Data(); !ok || !present || data != "compressed text" {
			t.Errorf("packed = %#v", vals["packed"])
		}
		if vals["note"] != "plain text" {
			t.Errorf("note was not in the default select set: %#v", vals["note"])
		}
		if styled, ok := vals["payload"].(orm.StyledValue); !ok || styled.Kind() != "sql-null" {
			t.Errorf("selected styled SQL NULL = %#v", vals["payload"])
		}
	})
}

// Requirements: INT-98.
// TestRuntimeInvalidCellsFailTypedReads writes invalid physical cells through
// the driver and verifies that model decoding reports the declared-type error.
func TestRuntimeInvalidCellsFailTypedReads(t *testing.T) {
	testcase.Start(t, testcase.Database)
	s := documentSchema(t, valueTypesDocument)
	columns := []string{"seq", "small", "wide", "ratio", "active", "ref", "clock", "day", "address", "packed", "payload", "note"}
	eachDatabase(t, []string{"sqlite", "mysql", "postgres"}, s, 1, func(t *testing.T, driver, dsn string, db *orm.DB) {
		entity := rowEntity("typed_value", s, columns...)
		insert := orm.NewCore(entity)
		insert.Connect(db)
		insert.Set("small", int16(1))
		insert.Set("wide", int64(1))
		insert.Set("ratio", 1.25)
		insert.Set("active", true)
		insert.Set("ref", "0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e")
		insert.Set("clock", "10:20:30.500")
		insert.Set("day", "2026-02-03")
		insert.Set("address", nil)
		insert.Set("packed", orm.SqlNull())
		insert.Set("payload", orm.SqlNull())
		insert.Set("note", "row")
		created, err := insert.Create()
		if err != nil {
			t.Fatal(err)
		}
		seq := as[*keywordRow](t, created).vals["seq"]
		raw := openRaw(t, driver, dsn)
		defer testcase.Close(t, raw)
		bind := "?"
		if driver == "postgres" {
			bind = "$1"
		}
		var mutation string
		switch driver {
		case "mysql":
			if _, err := raw.Exec("ALTER TABLE typed_value MODIFY wide BIGINT UNSIGNED"); err != nil {
				t.Fatal(err)
			}
			mutation = "UPDATE typed_value SET wide = 18446744073709551615 WHERE seq = " + bind
		case "postgres":
			mutation = "UPDATE typed_value SET ratio = 'NaN'::double precision WHERE seq = " + bind
		case "sqlite":
			raw.SetMaxOpenConns(1)
			if _, err := raw.Exec("PRAGMA ignore_check_constraints = ON"); err != nil {
				t.Fatal(err)
			}
			mutation = "UPDATE typed_value SET wide = 'not-an-integer' WHERE seq = " + bind
		}
		if _, err := raw.Exec(mutation, seq); err != nil {
			t.Fatal(err)
		}
		badColumn := "wide"
		if driver == "postgres" {
			badColumn = "ratio"
		}
		read := orm.NewCore(entity)
		read.Connect(db)
		read.Set("seq", seq)
		read.AddColumn(badColumn)
		if _, err := orm.Gets[*keywordRow](read); orm.ErrorCode(err) != orm.CodeCodecDecode {
			t.Errorf("invalid %s cell error = %v", badColumn, err)
		}
		if driver == "mysql" {
			if _, err := raw.Exec("UPDATE typed_value SET active = 2 WHERE seq = "+bind, seq); err != nil {
				t.Fatal(err)
			}
			boolRead := orm.NewCore(entity)
			boolRead.Connect(db)
			boolRead.Set("seq", seq)
			boolRead.AddColumn("active")
			if _, err := orm.Gets[*keywordRow](boolRead); orm.ErrorCode(err) != orm.CodeCodecDecode {
				t.Errorf("invalid bool cell error = %v", err)
			}
		}
	})
}
