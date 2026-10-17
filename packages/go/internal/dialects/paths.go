package dialects

import "path/filepath"

// repoRoot is the root of the checkout. go test runs this package in its own directory, four levels below the root.
var repoRoot = filepath.Join("..", "..", "..", "..")
