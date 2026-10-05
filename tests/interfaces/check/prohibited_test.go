package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/polyspec/orm/internal/testcase"
)

func TestMultiStatementProhibitionIsMandatory(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	for _, prohibited := range [][]string{
		{"query_cancel"},
		{"multi_statement", "multi_statement", "query_cancel"},
	} {
		if err := validateProhibitions(prohibited); err == nil {
			t.Fatalf("invalid prohibited symbol list accepted: %v", prohibited)
		}
	}
	if err := validateProhibitions([]string{"multi_statement", "query_cancel"}); err != nil {
		t.Fatal(err)
	}
}

func TestProhibitedSymbolsUseLanguageNameForms(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	for _, symbols := range []Symbols{
		{"Query.MultiStatement": "func(bool) Query"},
		{"Query::multi_statement": "public function multi_statement(bool): Query"},
		{"Query.multiStatement": "multiStatement(value: boolean): Query"},
	} {
		if got := checkProhibitedSymbols("test", symbols, []string{"multi_statement"}); len(got) != 1 {
			t.Fatalf("prohibited symbol result = %#v", got)
		}
	}
	if got := checkProhibitedSymbols("test", Symbols{"Query.stream": "func(visitor) StreamResult"}, []string{"multi_statement"}); len(got) != 0 {
		t.Fatalf("unrelated symbol rejected: %#v", got)
	}
}

func TestAttemptedMultiStatementCallsFailInterfaceValidation(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	cases := []struct{ language, suffix, call, safe string }{
		{"go", ".go", "query.MultiStatement(true)", "query.Gets()"},
		{"php", ".php", "$query->multi_statement(true)", "$query->gets()"},
		{"rust", ".rs", "query.multi_statement(true)", "query.gets()"},
		{"typescript", ".ts", "query.multiStatement(true)", "query.gets()"},
	}
	for _, tc := range cases {
		t.Run(tc.language, func(t *testing.T) {
			root := t.TempDir()
			path := filepath.Join(root, "client"+tc.suffix)
			if err := os.WriteFile(path, []byte(tc.safe), 0600); err != nil {
				t.Fatal(err)
			}
			failures, err := checkCallsInRoots(root, tc.language, []string{"."})
			if err != nil || len(failures) != 0 {
				t.Fatalf("safe call: %v %v", failures, err)
			}
			if err := os.WriteFile(path, []byte(tc.call), 0600); err != nil {
				t.Fatal(err)
			}
			failures, err = checkCallsInRoots(root, tc.language, []string{"."})
			if err != nil || len(failures) != 1 {
				t.Fatalf("prohibited call: %v %v", failures, err)
			}
		})
	}
}

// TestCIRequiresGeneratedChecks는 CI가 생성 model 검사(go-model-check, ts-model-check)와 공통
// interface 검사를 실행하는지 확인한다. CI는 make check로 CHECK_TARGETS를 모두 실행하고
// (make repo-check가 빠진 target을 거부한다), interface 검사는 make check의 feature-check가
// contracts/features.json의 검증 명령으로 실행한다.
func TestCIRequiresGeneratedChecks(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	read := func(path ...string) string {
		data, err := os.ReadFile(filepath.Join(append([]string{"..", "..", ".."}, path...)...))
		if err != nil {
			t.Fatal(err)
		}
		return string(data)
	}
	workflow, makefile, features := read(".github", "workflows", "ci.yml"), read("Makefile"), read("contracts", "features.json")
	if err := validateGeneratedCI(workflow, makefile, features); err != nil {
		t.Fatal(err)
	}
	for _, mutation := range []struct{ name, workflow, makefile, features string }{
		{"make check", strings.Replace(workflow, "run: make check", "run: true", 1), makefile, features},
		{"go-model-check", workflow, withoutCheckTarget(makefile, "go-model-check"), features},
		{"ts-model-check", workflow, withoutCheckTarget(makefile, "ts-model-check"), features},
		{"interface-check", workflow, makefile, strings.Replace(features, interfaceCommand, "true", 1)},
	} {
		if mutation.workflow == workflow && mutation.makefile == makefile && mutation.features == features {
			t.Fatalf("missing mutation target %s", mutation.name)
		}
		if err := validateGeneratedCI(mutation.workflow, mutation.makefile, mutation.features); err == nil {
			t.Fatalf("CI without %s passed", mutation.name)
		}
	}
}

// withoutCheckTarget은 CHECK_TARGETS 줄에서 target 하나를 뺀 Makefile을 돌려준다.
func withoutCheckTarget(makefile, target string) string {
	lines := strings.Split(makefile, "\n")
	for index, line := range lines {
		if rest, ok := strings.CutPrefix(line, "CHECK_TARGETS = "); ok {
			kept := []string{}
			for _, field := range strings.Fields(rest) {
				if field != target {
					kept = append(kept, field)
				}
			}
			lines[index] = "CHECK_TARGETS = " + strings.Join(kept, " ")
		}
	}
	return strings.Join(lines, "\n")
}

// interfaceCommand는 make interface-check의 명령이며 feature-check가 검증 명령으로 실행한다. go run 대신
// tests/go-run.mjs가 checker를 build해 실행한다.
const interfaceCommand = "node tests/go-run.mjs interfaces-check ./tests/interfaces/check --self-test"

func validateGeneratedCI(workflow, makefile, features string) error {
	runsCheck := false
	for _, line := range strings.Split(workflow, "\n") {
		if strings.TrimSpace(line) == "run: make check" {
			runsCheck = true
		}
	}
	if !runsCheck {
		return fmt.Errorf("CI must run make check")
	}
	targets := map[string]bool{}
	for _, line := range strings.Split(makefile, "\n") {
		if rest, ok := strings.CutPrefix(line, "CHECK_TARGETS = "); ok {
			for _, target := range strings.Fields(rest) {
				targets[target] = true
			}
		}
	}
	for _, target := range []string{"go-model-check", "ts-model-check"} {
		if !targets[target] {
			return fmt.Errorf("CHECK_TARGETS must include %s", target)
		}
	}
	if !strings.Contains(features, interfaceCommand) {
		return fmt.Errorf("contracts/features.json must verify %s", interfaceCommand)
	}
	return nil
}
