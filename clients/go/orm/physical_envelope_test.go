package orm

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

func TestPhysicalEnvelope(t *testing.T) {
	data, err := os.ReadFile("../../../contracts/fixtures/physical_envelope.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Cases []struct {
			ID, Text, Body, Before, After string
			Line                          int
			Reject                        bool
		}
		Limits struct{ Bytes, Lines, Blocks int }
	}
	if err = json.Unmarshal(data, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Cases) != 21 {
		t.Fatal("missing cases")
	}
	check := func(id, text string, reject bool, line int, before, body, after string) {
		t.Helper()
		t.Run(id, func(t *testing.T) {
			start := time.Now()
			t.Log("RUN", id)
			defer func() {
				t.Log("DONE", id, time.Since(start))
				if time.Since(start) > 15*time.Second {
					t.Fatal("deadline exceeded")
				}
			}()
			r, e := LocatePhysicalEnvelope([]byte(text))
			if reject {
				var located *PhysicalEnvelopeError
				if !errors.As(e, &located) || e.Error() != "SCHEMA_INVALID" || located.Line() != line {
					t.Fatalf("wrong diagnostic: %v", e)
				}
				return
			}
			if e != nil {
				t.Fatal(e)
			}
			if r.Start > r.Body || r.Body > r.Close || r.Close > r.End || r.End > len(text) {
				t.Fatal("invalid ranges")
			}
			if before != "<bounds>" && (text[:r.Start] != before || text[r.Body:r.Close] != body || text[r.End:] != after) {
				t.Fatal("source changed")
			}
		})
	}
	for _, c := range f.Cases {
		check(c.ID, c.Text, c.Reject, c.Line, c.Before, c.Body, c.After)
	}
	block := "```mermaid orm-physical-v1\n```\n"
	for _, n := range []int{f.Limits.Bytes, f.Limits.Bytes + 1} {
		check(fmt.Sprintf("bytes-%d", n-f.Limits.Bytes), strings.Repeat("x", n-len(block)-1)+"\n"+block, n > f.Limits.Bytes, 0, "<bounds>", "", "")
	}
	for _, n := range []int{f.Limits.Lines, f.Limits.Lines + 1} {
		check(fmt.Sprintf("lines-%d", n-f.Limits.Lines), strings.Repeat("\n", n-3)+block, n > f.Limits.Lines, 0, "<bounds>", "", "")
	}
	for _, n := range []int{f.Limits.Blocks, f.Limits.Blocks + 1} {
		check(fmt.Sprintf("blocks-%d", n-f.Limits.Blocks), strings.Repeat("```text\n```\n", n-1)+block, n > f.Limits.Blocks, 0, "<bounds>", "", "")
	}
	check("invalid-utf8", string([]byte{255}), true, 0, "", "", "")
}
