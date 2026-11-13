package model_test

import (
	"testing"

	"github.com/polyspec/orm/legacy/packages/go/model"
	"github.com/polyspec/orm/legacy/packages/go/orm"
	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// A time setter records a text that is not a time as the statement's error: the first bad set wins, the statement
// returns CODEC_ENCODE naming the column, and no row changes (T189).
// Requirements: PRT-67a.
func TestTimeSetterRecordsBadText(t *testing.T) {
	testcase.Start(t, testcase.Database)
	each(t, func(t *testing.T, db *orm.DB) {
		before := must(model.TimeCell().Connect(db).GetCount())
		// The first bad set stays the error of the statement although a later set of the same column is good; the
		// error names the column and no value (INT-163).
		_, err := model.TimeCell().Connect(db).SetAt("bad1").SetAt("2026-06-01 12:34:56").Create()
		if orm.ErrorCode(err) != orm.CodeCodecEncode {
			t.Fatalf("Create code = %q, want %q (err %v)", orm.ErrorCode(err), orm.CodeCodecEncode, err)
		}
		if msg, want := err.Error(), "CODEC_ENCODE: time_cell.at: datetime value is not a datetime"; msg != want || contains(msg, "bad1") {
			t.Fatalf("Create error %q, want %q", msg, want)
		}
		if after := must(model.TimeCell().Connect(db).GetCount()); after != before {
			t.Fatalf("rows changed from %d to %d", before, after)
		}
		row := must(must(model.TimeCell().Connect(db).SetAt("2026-06-01 12:34:56").SetClock("10:11:12")).Create())
		if _, err := row.SetAt("bad4").Update(); orm.ErrorCode(err) != orm.CodeCodecEncode {
			t.Fatalf("Update code = %q, want %q (err %v)", orm.ErrorCode(err), orm.CodeCodecEncode, err)
		}
		if _, err := model.TimeCell().Connect(db).SetAt("bad3").GetQuery(); orm.ErrorCode(err) != orm.CodeCodecEncode {
			t.Fatalf("GetQuery code = %q, want %q", orm.ErrorCode(err), orm.CodeCodecEncode)
		}
	})
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
