// Package generator exposes the Go model generator to other programs.
package generator

import (
	"fmt"

	"github.com/polyspec/orm/engine/schema"
	"github.com/polyspec/orm/internal/ormgen"
)

// Options describes one deterministic Go generation request.
type Options struct {
	Manifest  *schema.Manifest
	OutputDir string
	// PackageName selects the Go package name; the directory name by default.
	PackageName string
	// Scan lists the Go package patterns whose model calls are generated.
	Scan []string
}

// Generate writes the Go models described by the manifest to OutputDir. An
// error leaves OutputDir unchanged, except an error reporting that the scanned
// packages do not compile with the complete models written to OutputDir.
func Generate(options Options) error {
	if options.Manifest == nil {
		return fmt.Errorf("manifest is required")
	}
	if options.OutputDir == "" {
		return fmt.Errorf("output directory is required")
	}
	return ormgen.GenerateGo(options.Manifest, options.OutputDir, options.PackageName, options.Scan)
}
