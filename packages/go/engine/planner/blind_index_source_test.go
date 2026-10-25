package planner

import (
	"slices"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/engine/dialect"
	"github.com/polyspec/orm/packages/go/engine/ir"
	"github.com/polyspec/orm/packages/go/engine/plan"
	"github.com/polyspec/orm/packages/go/testcase"
)

const sharedBlindIndexDocument = `dbspec 1 shared_blind_index

table record {
  id i64 identity
  version i32
  name varchar(191)
  aes_a bytes null
  aes_b bytes null
  idx varchar(64) null
  primary key (id)
  unique uq_record_idx (idx)
  settings {
    codec aes_a aes
    codec aes_b aes
    aes_version version
    blind_index aes_a idx
    blind_index aes_b idx
  }
}
`

func compileSharedBlindIndex(t *testing.T, request *ir.Request) (*plan.Plan, error) {
	t.Helper()
	model := testModel(t, sharedBlindIndexDocument)
	request.IRVersion = ir.Version
	request.ManifestHash = model.ManifestHash
	if err := ir.Validate(model, request); err != nil {
		return nil, err
	}
	return (&Planner{M: model, D: dialect.MySQL{}}).Compile(request)
}

func blindIndexParams(p *plan.Plan) []int {
	var params []int
	for _, step := range p.Steps {
		for _, slot := range step.BindSlots {
			if slices.Contains(slot.HostStyles, "blind_index") {
				params = append(params, slot.Param)
			}
		}
	}
	return params
}

type blindIndexConflictCase struct {
	name   string
	set    []ir.Assign
	nParam int
}

func blindIndexConflictCases(firstParam int) []blindIndexConflictCase {
	return []blindIndexConflictCase{
		{
			name:   "different params",
			set:    []ir.Assign{{Column: "aes_a", P: intp(firstParam)}, {Column: "aes_b", P: intp(firstParam + 1)}},
			nParam: firstParam + 2,
		},
		{
			name:   "same param",
			set:    []ir.Assign{{Column: "aes_a", P: intp(firstParam)}, {Column: "aes_b", P: intp(firstParam)}},
			nParam: firstParam + 1,
		},
		{
			name:   "both null",
			set:    []ir.Assign{{Column: "aes_a", Null: true}, {Column: "aes_b", Null: true}},
			nParam: firstParam,
		},
	}
}

func requireBlindIndexConflict(t *testing.T, p *plan.Plan, err error, context string) {
	t.Helper()
	if err == nil || p != nil || !strings.Contains(err.Error(), "IR_INVALID") || !strings.Contains(err.Error(), "idx") || !strings.Contains(err.Error(), "aes_a") || !strings.Contains(err.Error(), "aes_b") {
		t.Fatalf("%s compile = (%v, %v), want IR_INVALID naming idx, aes_a and aes_b", context, p, err)
	}
}

// Requirements: COD-4.
func TestMultiRowBlindIndexUsesAssignedSourceAndOriginalRowOffsets(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	p, err := compileSharedBlindIndex(t, &ir.Request{
		Kind: "insert", Query: ir.Query{Entity: "record"},
		Set:  []ir.Assign{{Column: "name", P: intp(0)}, {Column: "aes_b", P: intp(1)}},
		Rows: [][]int{{2, 3}, {4, 5}}, NParams: 6,
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := blindIndexParams(p); !slices.Equal(got, []int{1, 3, 5}) {
		t.Fatalf("blind-index params = %v, want [1 3 5]", got)
	}
}

// Requirements: COD-4.
func TestBlindIndexDerivationRejectsDistinctSourcesRegardlessOfValues(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	for _, tc := range blindIndexConflictCases(1) {
		t.Run(tc.name, func(t *testing.T) {
			p, err := compileSharedBlindIndex(t, &ir.Request{
				Kind: "insert", Query: ir.Query{Entity: "record"},
				Set: append([]ir.Assign{{Column: "name", P: intp(0)}}, tc.set...), NParams: tc.nParam,
			})
			requireBlindIndexConflict(t, p, err, "insert")
		})
	}
}

// Requirements: COD-4.
func TestExplicitBlindIndexAssignmentWinsOverMultipleSources(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	p, err := compileSharedBlindIndex(t, &ir.Request{
		Kind: "insert", Query: ir.Query{Entity: "record"},
		Set: []ir.Assign{
			{Column: "name", P: intp(0)}, {Column: "aes_a", P: intp(1)}, {Column: "aes_b", P: intp(2)}, {Column: "idx", P: intp(3)},
		}, NParams: 4,
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := blindIndexParams(p); !slices.Equal(got, []int{3}) {
		t.Fatalf("explicit blind-index params = %v, want [3]", got)
	}
}

// Requirements: COD-4.
func TestInsertAndOnDuplicateBlindIndexAssignmentsAreIndependent(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	p, err := compileSharedBlindIndex(t, &ir.Request{
		Kind: "insert", Query: ir.Query{Entity: "record"},
		Set:         []ir.Assign{{Column: "name", P: intp(0)}, {Column: "aes_a", P: intp(1)}},
		OnDuplicate: []ir.Assign{{Column: "name", P: intp(2)}}, NParams: 3,
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := blindIndexParams(p); !slices.Equal(got, []int{1}) {
		t.Fatalf("blind-index params = %v, want only insert source [1]", got)
	}

	p, err = compileSharedBlindIndex(t, &ir.Request{
		Kind: "insert", Query: ir.Query{Entity: "record"},
		Set:         []ir.Assign{{Column: "name", P: intp(0)}, {Column: "idx", P: intp(1)}},
		OnDuplicate: []ir.Assign{{Column: "aes_a", P: intp(2)}, {Column: "aes_b", P: intp(3)}, {Column: "idx", P: intp(4)}},
		NParams:     5,
	})
	if err != nil {
		t.Fatalf("explicit on_duplicate target with both sources: %v", err)
	}
	if got := blindIndexParams(p); !slices.Equal(got, []int{1, 4}) {
		t.Fatalf("explicit insert/on_duplicate blind-index params = %v, want [1 4]", got)
	}
}

// Requirements: COD-4.
func TestOnDuplicateRejectsDistinctSourcesWithoutExplicitTarget(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	for _, tc := range blindIndexConflictCases(2) {
		t.Run(tc.name, func(t *testing.T) {
			p, err := compileSharedBlindIndex(t, &ir.Request{
				Kind: "insert", Query: ir.Query{Entity: "record"},
				Set:         []ir.Assign{{Column: "name", P: intp(0)}, {Column: "idx", P: intp(1)}},
				OnDuplicate: tc.set, NParams: tc.nParam,
			})
			requireBlindIndexConflict(t, p, err, "on_duplicate")
		})
	}
}

// Requirements: COD-4.
func TestOrdinaryInsertHasNoBlindIndexAssignments(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	p, err := compileSharedBlindIndex(t, &ir.Request{
		Kind: "insert", Query: ir.Query{Entity: "record"}, Set: []ir.Assign{{Column: "name", P: intp(0)}}, NParams: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := blindIndexParams(p); len(got) != 0 {
		t.Fatalf("ordinary insert blind-index params = %v, want none", got)
	}
}
