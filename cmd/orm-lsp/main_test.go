package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/polyspec/orm/internal/testcase"
)

// TestSession runs one LSP session over a pipe: initialize answers the capabilities, an opened
// document publishes the diagnostics of its parse, semanticTokens/full answers the highlight of
// the grammar core and formatting answers the canonical emit, and shutdown ends the session.
func TestSession(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	text := "dbspec 1 x\n\ntable users {\n  id i64 identity\n  primary key (id)\n}\n"
	var in bytes.Buffer
	msg := func(v any) {
		b, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		fmt.Fprintf(&in, "Content-Length: %d\r\n\r\n", len(b))
		in.Write(b)
	}
	msg(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{}})
	msg(map[string]any{"jsonrpc": "2.0", "method": "initialized", "params": map[string]any{}})
	msg(map[string]any{"jsonrpc": "2.0", "method": "textDocument/didOpen", "params": map[string]any{
		"textDocument": map[string]any{"uri": "file:///x.dbs", "text": text}}})
	msg(map[string]any{"jsonrpc": "2.0", "id": 2, "method": "textDocument/semanticTokens/full", "params": map[string]any{
		"textDocument": map[string]any{"uri": "file:///x.dbs"}}})
	msg(map[string]any{"jsonrpc": "2.0", "id": 3, "method": "textDocument/formatting", "params": map[string]any{
		"textDocument": map[string]any{"uri": "file:///x.dbs"}, "options": map[string]any{}}})
	msg(map[string]any{"jsonrpc": "2.0", "id": 4, "method": "shutdown"})
	var out bytes.Buffer
	run(bytes.NewReader(in.Bytes()), &out)
	s := out.String()
	for _, want := range []string{
		`"documentFormattingProvider":true`,
		`"method":"textDocument/publishDiagnostics"`,
		`"diagnostics":[]`,
		`"id":2`,
		`"id":3`,
		`"newText":"dbspec 1 x\n\ntable users {\n  id i64 identity\n  primary key (id)\n}\n"`,
		`"id":4`,
	} {
		if !bytes.Contains(out.Bytes(), []byte(want)) {
			t.Fatalf("the session answer holds no %s:\n%s", want, s)
		}
	}
}
