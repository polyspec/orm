package dbspec

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

func TestParseSet(t *testing.T) {
	testcase.Start(t, testcase.Process)
	shop := "dbspec 1 shop\n\nuse core { account }\n\ntable item {\n  seq i64\n  account_seq i64\n  primary key (seq)\n  index ix_item_account (account_seq)\n  foreign key fk_item_account (account_seq) references account (seq) on delete restrict on update restrict\n}\n"
	core := "dbspec 1 core\n\ntable account {\n  seq i64\n  primary key (seq)\n}\n"
	got := ParseSet([]string{shop}, []string{core})
	if len(got) != 2 {
		t.Fatalf("set %+v", got)
	}
	if d := got[0]; d.Name != "shop" || d.External || d.Document == nil || len(d.Positions) == 0 || len(d.Diagnostics) > 0 {
		t.Fatalf("shop %+v", d)
	}
	if d := got[1]; d.Name != "core" || !d.External || d.Document == nil || !d.Document.External {
		t.Fatalf("core %+v", d)
	}
	repeated := ParseSet([]string{core, core}, nil)
	if d := repeated[1]; len(d.Diagnostics) != 1 || d.Diagnostics[0].Rule != RuleNameDuplicate || d.Document != nil {
		t.Fatalf("repeated %+v", repeated)
	}
	bad := ParseSet([]string{"table x {}\n"}, nil)
	if d := bad[0]; d.Name != "" || d.Document != nil || len(d.Diagnostics) == 0 || d.Diagnostics[0].Rule != RuleHeader {
		t.Fatalf("bad header %+v", d)
	}
}

// TestParseSetVectors runs the shared vectors of tests/dbspec/set-parse.json (docs/spec/dbspec.md "Parsing a set"): the
// name, the external mark, whether the text parsed and the rule, place and, when given, the message of each diagnostic.
func TestParseSetVectors(t *testing.T) {
	testcase.Start(t, testcase.Process)
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "tests", "dbspec", "set-parse.json"))
	if err != nil {
		t.Fatal(err)
	}
	type diag struct {
		Rule, Message string
		Line, Column  int
	}
	var vectors struct {
		Cases []struct {
			ID, Name        string
			Owned, External []string
			Documents       []struct {
				Name        string
				External    bool
				Parsed      bool
				Diagnostics []diag
			}
		}
	}
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	for _, c := range vectors.Cases {
		t.Run(c.ID, func(t *testing.T) {
			got := ParseSet(c.Owned, c.External)
			if len(got) != len(c.Documents) {
				t.Fatalf("%s: %d documents, want %d", c.Name, len(got), len(c.Documents))
			}
			for i, want := range c.Documents {
				d := got[i]
				if d.Name != want.Name || d.External != want.External || (d.Document != nil) != want.Parsed || len(d.Diagnostics) != len(want.Diagnostics) {
					t.Errorf("%s: document %d is %q external=%v parsed=%v with %d diagnostics, want %+v", c.Name, i, d.Name, d.External, d.Document != nil, len(d.Diagnostics), want)
					continue
				}
				for k, w := range want.Diagnostics {
					if x := d.Diagnostics[k]; x.Rule != w.Rule || x.Line != w.Line || x.Column != w.Column || (w.Message != "" && x.Message != w.Message) {
						t.Errorf("%s: document %d diagnostic %d is %+v, want %+v", c.Name, i, k, x, w)
					}
				}
			}
		})
	}
}
