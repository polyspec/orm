// orm-lsp is a Language Server Protocol server for dbspec documents over standard input and
// output (the way template-lsp serves template sources, over the grammar core of this repository
// instead of a TypeScript one). It publishes the diagnostics of dbspec.Parse, answers
// textDocument/semanticTokens/full from dbspec.Tokens and textDocument/formatting from
// dbspec.Emit, with full-document synchronization; a document set of one file per document.
//
//	orm-lsp --stdio
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"

	"github.com/polyspec/orm/engine/dbspec"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] != "--stdio" {
		fmt.Fprintln(os.Stderr, "usage: orm-lsp --stdio")
		os.Exit(2)
	}
	run(os.Stdin, os.Stdout)
}

// run answers one JSON-RPC session of LSP base protocol messages.
func run(in io.Reader, out io.Writer) {
	documents := map[string]string{}
	reply := func(id any, result any) {
		write(out, map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
	}
	notify := func(method string, params any) {
		write(out, map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
	}
	publish := func(uri string) {
		text := documents[uri]
		_, diagnostics := dbspec.Parse(text, nil)
		list := make([]map[string]any, 0, len(diagnostics))
		for _, d := range diagnostics {
			list = append(list, map[string]any{
				"range":    rangeOf(d.Line, d.Column, d.Line, d.Column+len(d.Rule)),
				"severity": 1, "source": "dbspec",
				"message": d.Rule + ": " + d.Message,
			})
		}
		notify("textDocument/publishDiagnostics", map[string]any{"uri": uri, "diagnostics": list})
	}
	reader := bufio.NewReader(in)
	for {
		length := 0
		for {
			line, err := reader.ReadString('\n')
			if err != nil {
				return
			}
			line = strings.TrimRight(line, "\r\n")
			if line == "" {
				break
			}
			if strings.HasPrefix(line, "Content-Length:") {
				length, _ = strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(line, "Content-Length:")))
			}
		}
		if length == 0 {
			continue
		}
		body := make([]byte, length)
		if _, err := io.ReadFull(reader, body); err != nil {
			return
		}
		var msg struct {
			ID     *json.Number   `json:"id"`
			Method string         `json:"method"`
			Params map[string]any `json:"params"`
		}
		if json.Unmarshal(body, &msg) != nil {
			continue
		}
		if msg.ID == nil {
			switch msg.Method {
			case "exit":
				return
			case "textDocument/didOpen":
				documents[uri(msg.Params["textDocument"])] = text(msg.Params["textDocument"])
				publish(uri(msg.Params["textDocument"]))
			case "textDocument/didChange":
				documents[uri(msg.Params["textDocument"])] = textOfChange(msg.Params)
				publish(uri(msg.Params["textDocument"]))
			case "textDocument/didClose":
				delete(documents, uri(msg.Params["textDocument"]))
				notify("textDocument/publishDiagnostics", map[string]any{"uri": uri(msg.Params["textDocument"]), "diagnostics": []any{}})
			}
			continue
		}
		switch msg.Method {
		case "initialize":
			reply(msg.ID, map[string]any{"capabilities": map[string]any{
				"positionEncoding":           "utf-16",
				"textDocumentSync":           map[string]any{"openClose": true, "change": 1},
				"documentFormattingProvider": true,
				"semanticTokensProvider": map[string]any{
					"legend": map[string]any{"tokenTypes": []string{"keyword", "type", "number", "string", "comment", "operator"}},
					"full":   true,
				},
			}})
		case "shutdown":
			reply(msg.ID, nil)
		case "textDocument/semanticTokens/full":
			cls := map[string]int{"kw": 0, "ty": 1, "num": 2, "str": 3, "cmt": 4, "punc": 5}
			data := []int{}
			line, start := 0, 0
			for _, t := range dbspec.Tokens(documents[uriOfParams(msg.Params)]) {
				dl, dc := t.Line-1-line, t.Start
				if dl != 0 {
					dc = t.Start
				} else {
					dc = t.Start - start
				}
				data = append(data, dl, dc, t.End-t.Start, cls[t.Cls], 0)
				line, start = t.Line-1, t.Start
			}
			reply(msg.ID, map[string]any{"data": data})
		case "textDocument/formatting":
			text := documents[uriOfParams(msg.Params)]
			document, _ := dbspec.Parse(text, nil)
			if document == nil {
				reply(msg.ID, []any{})
				continue
			}
			formatted := dbspec.Emit(document)
			lines := strings.Count(text, "\n")
			reply(msg.ID, []any{map[string]any{
				"range":   rangeOf(0, 0, lines+1, 0),
				"newText": formatted,
			}})
		default:
			write(out, map[string]any{"jsonrpc": "2.0", "id": msg.ID, "error": map[string]any{"code": -32601, "message": "method not found: " + msg.Method}})
		}
	}
}

func uri(v any) string  { d, _ := v.(map[string]any); s, _ := d["uri"].(string); return s }
func text(v any) string { d, _ := v.(map[string]any); s, _ := d["text"].(string); return s }

func uriOfParams(p map[string]any) string { return uri(p["textDocument"]) }

// textOfChange reads the full text of a didChange with full synchronization.
func textOfChange(p map[string]any) string {
	c, _ := p["contentChanges"].([]any)
	if len(c) == 0 {
		return ""
	}
	first, _ := c[0].(map[string]any)
	s, _ := first["text"].(string)
	return s
}

func rangeOf(sl, sc, el, ec int) map[string]any {
	return map[string]any{"start": map[string]int{"line": sl, "character": sc}, "end": map[string]int{"line": el, "character": ec}}
}

// write sends one framed message.
func write(out io.Writer, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	fmt.Fprintf(out, "Content-Length: %d\r\n\r\n", len(b))
	out.Write(b)
}
