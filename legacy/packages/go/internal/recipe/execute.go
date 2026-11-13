package recipe

import (
	"encoding/json"
	"fmt"
	"path/filepath"

	"github.com/polyspec/orm/legacy/packages/go/engine/runtimemodel"
)

// executeRequest is db.execute (INT-76, DSL-113): it compiles the request of the step against the schema that the step names
// relative to the recipe, for the dialect of the database of the case (SQLite for markdown, FCV-3), and runs the first step
// of the plan with Execute on the connection, with the parameters of the step.
func executeRequest(s databaseStep, c *databaseContext) error {
	db, err := connectionOf(s, c)
	if err != nil {
		return err
	}
	var schema string
	if err := json.Unmarshal(s.k("schema").Schema, &schema); err != nil {
		return fmt.Errorf("db.execute: the schema is not a path: %w", err)
	}
	m, err := runtimemodel.LoadFiles(filepath.Join(c.dir, schema))
	if err != nil {
		return err
	}
	request, err := withManifestHash(s.k("request").Request, m.ManifestHash, "db.execute: the request")
	if err != nil {
		return err
	}
	compiled, err := compiledPlan(m, c.dialect(), request)
	if err != nil {
		return err
	}
	params := make([]any, 0, len(s.k("params").Params))
	for _, raw := range s.Params {
		param, err := argument(raw, nil)
		if err != nil {
			return err
		}
		params = append(params, param)
	}
	return db.Execute(&compiled.Steps[0], params)
}
