package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/polyspec/orm/internal/testcase"
)

// sequence case는 conformance 출력을 공통 state contract의 statement kind 목록과 비교해, 다를 때 더해지거나
// 빠진 statement를 위치, kind, SQL과 함께 적는지 확인한다. utility statement는 dialect마다 다르므로 비교하지
// 않는다. now_defaults의 출력은 MySQL의 것과 같은 모양이다: begin, insert, select, delete, commit.
func TestSequencesNameAddedAndMissingStatements(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	sequences := []Sequence{{ID: "now_defaults", Expected: map[string]any{"created_equals_updated": true}, Statements: []string{"begin", "insert", "select", "delete", "commit"}}}
	output := func(list string) map[string]sequenceOutput {
		var parsed map[string]sequenceOutput
		if err := json.Unmarshal([]byte(`{"now_defaults":{"result":{"created_equals_updated":true},"statements":[`+list+`]}}`), &parsed); err != nil {
			t.Fatal(err)
		}
		return parsed
	}
	statements := `{"kind":"begin","sql":"START TRANSACTION"},{"kind":"insert","sql":"INSERT a"},{"kind":"select","sql":"SELECT a"},{"kind":"delete","sql":"DELETE a"},{"kind":"commit","sql":"COMMIT"}`
	if problems := checkSequences("go.json", output(statements), sequences); len(problems) != 0 {
		t.Fatal(problems)
	}
	if problems := checkSequences("go.json", output(statements+`,{"kind":"utility","sql":"SELECT GET_LOCK(?, 50)"}`), sequences); len(problems) != 0 {
		t.Fatal("a utility statement was compared:", problems)
	}
	for list, want := range map[string][]string{
		// T42 이전의 contract(model statement만)와 오늘의 출력이 다른 모양이다.
		`{"kind":"insert","sql":"INSERT a"},{"kind":"select","sql":"SELECT a"},{"kind":"delete","sql":"DELETE a"}`: {strings.Join([]string{
			"go.json: state contract now_defaults: statements other than utility differ from the contract: -2 transaction-control",
			"  - #1 begin",
			"  - #5 commit",
		}, "\n")},
		statements + `,{"kind":"update","sql":"UPDATE a"}`: {strings.Join([]string{
			"go.json: state contract now_defaults: statements other than utility differ from the contract: +1 model",
			"  + #6 update UPDATE a",
		}, "\n")},
		statements + `,{"sql":"SET x"}`:                {"go.json: state contract now_defaults: statement #6 (SET x) has no kind"},
		statements + `,{"kind":"other","sql":"SET x"}`: {`go.json: state contract now_defaults: statement #6 (SET x) has the unknown kind "other"`},
	} {
		if problems := checkSequences("go.json", output(list), sequences); !reflect.DeepEqual(problems, want) {
			t.Fatalf("statements %s:\nproblems %q\nwant     %q", list, problems, want)
		}
	}
	wrong := output(statements)
	wrong["now_defaults"] = sequenceOutput{Result: map[string]any{"created_equals_updated": false}, Statements: wrong["now_defaults"].Statements}
	if problems := checkSequences("go.json", wrong, sequences); !reflect.DeepEqual(problems, []string{`go.json: state contract now_defaults: result {"created_equals_updated":false}, expected {"created_equals_updated":true}`}) {
		t.Fatal(problems)
	}
	if problems := checkSequences("go.json", map[string]sequenceOutput{}, sequences); !reflect.DeepEqual(problems, []string{"go.json: state contract now_defaults: the output has no now_defaults vector"}) {
		t.Fatal(problems)
	}
}

// missing input case는 conformance 실행이 쓰지 않은 output file을 그 정확한 경로로 적는지 확인한다.
func TestResultsNameAMissingOutput(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, "go.json"), []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	problems := checkResults(directory, []string{"go", "php"}, nil)
	want := []string{"missing input " + filepath.Join(directory, "php.json") + ": the conformance run of this check did not write the php output"}
	if !reflect.DeepEqual(problems, want) {
		t.Fatalf("problems %q, want %q", problems, want)
	}
}
