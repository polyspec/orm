package dialects

import "github.com/polyspec/orm/legacy/packages/go/testcase"

// repoRoot is the root of the checkout, which holds docs/spec and contracts/implementations.json; the runners of the
// clients run there, so that the Python runners resolve as modules of legacy.packages.python.
var repoRoot = testcase.RepositoryRoot()

// legacyRoot is the legacy directory of the checkout, which holds the clients and the fixtures and vectors they read.
var legacyRoot = testcase.LegacyRoot()
