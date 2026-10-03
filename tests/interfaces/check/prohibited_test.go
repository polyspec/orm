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

func TestCIRequiresGeneratedChecks(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	workflow, err := os.ReadFile(filepath.Join("..", "..", "..", ".github", "workflows", "ci.yml"))
	if err != nil {
		t.Fatal(err)
	}
	if err := validateGeneratedCI(string(workflow)); err != nil {
		t.Fatal(err)
	}
	for _, command := range []string{"go-model-check", "ts-model-check", "interface-check"} {
		changed := strings.Replace(string(workflow), "run: make "+command, "run: true", 1)
		if changed == string(workflow) {
			t.Fatalf("missing mutation target %s", command)
		}
		if err := validateGeneratedCI(changed); err == nil {
			t.Fatalf("CI without %s passed", command)
		}
	}
}

func validateGeneratedCI(workflow string) error {
	commands := make(map[string]bool)
	for _, line := range strings.Split(workflow, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "run: make ") {
			commands[strings.TrimPrefix(line, "run: make ")] = true
		}
	}
	for _, command := range []string{"go-model-check", "ts-model-check", "interface-check"} {
		if !commands[command] {
			return fmt.Errorf("CI must run make %s", command)
		}
	}
	return nil
}
