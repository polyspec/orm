package ir

import (
	"reflect"
	"testing"

	"github.com/polyspec/orm/engine/runtimemodel"
	"github.com/polyspec/orm/internal/testcase"
)

const paramUsesDocument = `dbspec 1 params

table owners {
  id varchar(16)
  name varchar(32)
  primary key (id)
}

table notes {
  id i64 identity
  owner varchar(16)
  title varchar(64)
  born date null
  at datetime(3)
  version datetime(6) null
  primary key (id)
  index ix_notes_owner (owner)
  foreign key fk_notes_owner (owner) references owners (id)
}
`

// paramUseOf는 비교를 쉽게 하려고 ParamUse를 type과 column 이름으로 줄인 것이다.
type paramUseOf struct{ Type, Column string }

func usesOf(uses [][]ParamUse) [][]paramUseOf {
	out := make([][]paramUseOf, len(uses))
	for i, list := range uses {
		for _, u := range list {
			name := ""
			if u.Column != nil {
				name = u.Column.Name
			}
			out[i] = append(out[i], paramUseOf{u.Type, name})
		}
	}
	return out
}

func p(i int) *int { return &i }

func TestParamUses(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	m, diagnostics := runtimemodel.Load(paramUsesDocument)
	if len(diagnostics) > 0 {
		t.Fatal(runtimemodel.DiagnosticsError(diagnostics))
	}
	read := &Request{IRVersion: Version, ManifestHash: m.ManifestHash, Kind: "all", NParams: 9, Query: Query{
		Entity: "notes",
		Where: &Group{Items: []Item{
			{Pred: &Pred{Column: "title", Op: "eq", P: p(0)}},
			{Pred: &Pred{Conn: "and", Column: "born", Op: "between", Ps: []int{1, 2}}},
			{Pred: &Pred{Conn: "and", Column: "at", Op: "eq", Fn: &Func{Name: "year"}, P: p(3)}},
			{Pred: &Pred{Conn: "and", Column: "at", Op: "gt", Value: &Func{Name: "days_ago", Ps: []int{4}}}},
			{Pred: &Pred{Conn: "and", Column: "title", Op: "contains", P: p(5)}},
			{Pred: &Pred{Conn: "and", Column: "at", Op: "eq", Fn: &Func{Name: "date"}, P: p(6)}},
			{Pred: &Pred{Conn: "and", Column: "at", Op: "lt", Value: &Func{Name: "seconds_later", Ps: []int{7}}}},
		}},
		Relations: []*Relation{{Rel: "owner_model", Kind: "one", Keys: []KeyPair{{Left: "owner", Right: "id"}}, Query: &Query{
			Entity:   "owners",
			IfParent: &IfParent{Column: "title", P: 8},
		}}},
	}}
	if err := Validate(m, read); err != nil {
		t.Fatal(err)
	}
	want := [][]paramUseOf{
		{{"varchar", "title"}},
		{{"date", "born"}},
		{{"date", "born"}},
		{{"i64", ""}},
		{{"i32", ""}},
		{{"text", ""}},
		{{"date", ""}},
		{{"f64", ""}},
		{{"varchar", "title"}},
	}
	if got := usesOf(ParamUses(m, read)); !reflect.DeepEqual(got, want) {
		t.Fatalf("read uses = %v\nwant %v", got, want)
	}
	insert := &Request{IRVersion: Version, ManifestHash: m.ManifestHash, Kind: "insert", NParams: 6, Query: Query{Entity: "notes"},
		Set:  []Assign{{Column: "owner", P: p(0)}, {Column: "title", P: p(1)}, {Column: "at", P: p(2)}},
		Rows: [][]int{{3, 4, 5}},
	}
	if err := Validate(m, insert); err != nil {
		t.Fatal(err)
	}
	want = [][]paramUseOf{
		{{"varchar", "owner"}}, {{"varchar", "title"}}, {{"datetime", "at"}},
		{{"varchar", "owner"}}, {{"varchar", "title"}}, {{"datetime", "at"}},
	}
	if got := usesOf(ParamUses(m, insert)); !reflect.DeepEqual(got, want) {
		t.Fatalf("insert uses = %v\nwant %v", got, want)
	}
	update := &Request{IRVersion: Version, ManifestHash: m.ManifestHash, Kind: "update", NParams: 3, Query: Query{Entity: "notes",
		Where: &Group{Items: []Item{{Pred: &Pred{Column: "id", Op: "eq", P: p(0)}}}}},
		Set:        []Assign{{Column: "title", P: p(1)}},
		Optimistic: &Optimist{Column: "version", P: 2},
	}
	if err := Validate(m, update); err != nil {
		t.Fatal(err)
	}
	want = [][]paramUseOf{{{"i64", "id"}}, {{"varchar", "title"}}, {{"datetime", "version"}}}
	if got := usesOf(ParamUses(m, update)); !reflect.DeepEqual(got, want) {
		t.Fatalf("update uses = %v\nwant %v", got, want)
	}
}
