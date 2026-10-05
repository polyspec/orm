package stmtdiff

import (
	"reflect"
	"testing"

	"github.com/polyspec/orm/internal/testcase"
)

// diff case는 차이를 더해지고 빠진 statement로, 그 위치와 kind와 text와 함께 적는지 확인한다.
func TestDiffNamesAddedAndMissingStatements(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	statement := func(kind, text string) Statement { return Statement{Kind: kind, Text: text, Key: kind + " " + text} }
	expected := []Statement{statement("insert", "INSERT a"), statement("select", "SELECT a"), statement("delete", "DELETE a")}
	got := []Statement{statement("begin", "START TRANSACTION"), statement("insert", "INSERT a"), statement("select", "SELECT b"), statement("delete", "DELETE a"), statement("commit", "COMMIT")}
	changes := Diff(expected, got)
	var lines []string
	for _, change := range changes {
		lines = append(lines, change.String())
	}
	want := []string{"+ #1 begin START TRANSACTION", "+ #3 select SELECT b", "- #2 select SELECT a", "+ #5 commit COMMIT"}
	if !reflect.DeepEqual(lines, want) {
		t.Fatalf("changes %q, want %q", lines, want)
	}
	if summary := Summary(changes, Group); summary != "+1 model, +2 transaction-control, -1 model" {
		t.Fatalf("summary %q", summary)
	}
	if changes := Diff(expected, expected); len(changes) != 0 {
		t.Fatalf("equal lists differ: %v", changes)
	}
}
