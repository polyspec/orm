// orm-tokens reads one dbspec document from its standard input and writes the highlight spans of
// its grammar (engine/dbspec Tokens) as one JSON array — the bridge the docs site renders its
// `dbs` code blocks through, so the site never re-states the grammar.
//
//	orm-tokens < file.dbs
package main

import (
	"encoding/json"
	"io"
	"os"

	"github.com/polyspec/orm/engine/dbspec"
)

func main() {
	text, err := io.ReadAll(os.Stdin)
	if err != nil {
		panic(err)
	}
	if err := json.NewEncoder(os.Stdout).Encode(dbspec.Tokens(string(text))); err != nil {
		panic(err)
	}
}
