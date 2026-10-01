package orm_test

import (
	"testing"
	"time"

	"github.com/polyspec/orm/clients/go/orm"
)

const valueTypesDocument = `dbspec 1 value_types

table typed_value {
  seq i64 identity
  small i16
  ref uuid
  clock time(3)
  day date
  address bytes null
  packed bytes null
  note text
  primary key (seq)
  settings {
    codec address ip
    codec packed gz
  }
}
`

// TestRuntimeValueTypes는 세 database에서 i16, uuid, time(p), date, ip codec,
// gz codec, select explicit 없는 text column을 쓰고 docs/dbspec.md "Runtime
// model"의 Go value type으로 다시 읽는다.
func TestRuntimeValueTypes(t *testing.T) {
	s := documentSchema(t, valueTypesDocument)
	columns := []string{"seq", "small", "ref", "clock", "day", "address", "packed", "note"}
	for _, driver := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(driver, func(t *testing.T) {
			start := time.Now()
			t.Logf("start %s", driver)
			defer func() { t.Logf("end %s in %s", driver, time.Since(start)) }()
			dsn := newDatabase(t, driver)
			db, err := orm.Connect(dsn, s, orm.Config{})
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			if err := db.Utils().Schema().Install(s.Text); err != nil {
				t.Fatal(err)
			}
			ent := rowEntity("typed_value", s, columns...)
			c := orm.NewCore(ent)
			c.Connect(db)
			c.Set("small", int16(-1234))
			c.Set("ref", "0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e")
			c.Set("clock", "10:20:30.500")
			c.Set("day", time.Date(2026, 2, 3, 0, 0, 0, 0, time.UTC))
			c.Set("address", "192.0.2.7")
			c.Set("packed", orm.Value("compressed text"))
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
			vals := row.(*keywordRow).vals
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
		})
	}
}
