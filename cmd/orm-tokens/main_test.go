package main

import (
	"bytes"
	"encoding/json"
	"os/exec"
	"strings"
	"testing"

	"github.com/polyspec/orm/engine/dbspec"
	"github.com/polyspec/orm/internal/testcase"
)

// TestTokensAnswer pins the bridge: orm-tokens writes exactly the JSON of dbspec.Tokens, the array
// the docs fence renders, so the site and an editor read the grammar core's own spans.
func TestTokensAnswer(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	bin, err := exec.LookPath("go")
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(bin, "run", ".")
	cmd.Stdin = strings.NewReader("dbspec 1 x\n\ntable users {\n  id i64 identity\n}\n")
	var out, errOut bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errOut
	if err := cmd.Run(); err != nil {
		t.Fatalf("orm-tokens: %v: %s", err, errOut.String())
	}
	var got []dbspec.Token
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatalf("the answer is not one JSON array: %v: %s", err, out.String())
	}
	want := dbspec.Tokens("dbspec 1 x\n\ntable users {\n  id i64 identity\n}\n")
	if len(got) == 0 || len(got) != len(want) {
		t.Fatalf("the answer holds %d tokens; the core holds %d", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("token %d: %+v; the core gives %+v", i, got[i], want[i])
		}
	}
}
