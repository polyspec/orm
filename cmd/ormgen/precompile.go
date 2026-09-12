package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"github.com/polyspec/orm/engine"
)

type precompiledPlan struct {
	Version    int             `json:"version"`
	SchemaHash string          `json:"schema_hash"`
	Dialect    string          `json:"dialect"`
	RequestSHA string          `json:"request_sha256"`
	Plan       json.RawMessage `json:"plan"`
}

func precompileCmd(args []string) {
	fs := flag.NewFlagSet("precompile", flag.ExitOnError)
	schemaPath := fs.String("schema", "", "schema.json (required)")
	dialect := fs.String("dialect", "mysql", "mysql|postgres|sqlite")
	in := fs.String("in", "", "request JSON (required)")
	out := fs.String("out", "", "compiled plan JSON (required)")
	fs.Parse(args)
	if *schemaPath == "" || *in == "" || *out == "" {
		fmt.Fprintln(os.Stderr, "usage: ormgen precompile --schema schema.json --dialect mysql|postgres|sqlite --in request.json --out plan.json")
		os.Exit(2)
	}
	schemaJSON, err := os.ReadFile(*schemaPath)
	if err != nil {
		fail(err)
	}
	requestJSON, err := os.ReadFile(*in)
	if err != nil {
		fail(err)
	}
	eng, err := engine.LoadJSON(schemaJSON, *dialect)
	if err != nil {
		fail(err)
	}
	plan, err := eng.Compile(requestJSON)
	if err != nil {
		fail(err)
	}
	hash := sha256.Sum256(requestJSON)
	output, err := json.MarshalIndent(precompiledPlan{
		Version: 1, SchemaHash: eng.M.SchemaHash, Dialect: *dialect,
		RequestSHA: hex.EncodeToString(hash[:]), Plan: plan,
	}, "", "  ")
	if err != nil {
		fail(err)
	}
	output = append(output, '\n')
	if err := os.WriteFile(*out, output, 0o644); err != nil {
		fail(err)
	}
	fmt.Fprintf(os.Stderr, "ormgen: precompiled schema %s (%s) -> %s\n", eng.M.SchemaHash, *dialect, *out)
}
