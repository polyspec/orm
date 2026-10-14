// Command orm-vet is the vet tool of the repository's Go rules (tests/analyzers): go vet -vettool runs it over each
// package, as make go-vet-check/orm does.
package main

import (
	"github.com/polyspec/orm/tests/analyzers"
	"golang.org/x/tools/go/analysis/unitchecker"
)

func main() {
	unitchecker.Main(analyzers.All...)
}
