// Package generator exposes the Go model generator to other programs.
package generator

import (
	"fmt"

	"github.com/polyspec/orm/engine/runtimemodel"
	"github.com/polyspec/orm/internal/ormgen"
)

// Options describes one deterministic Go generation request.
type Options struct {
	// Model은 dbspec document set의 runtime model이다.
	Model     *runtimemodel.Model
	OutputDir string
	// PackageName selects the Go package name; the directory name by default.
	PackageName string
	// Scan lists the Go package patterns whose model calls are generated.
	Scan []string
}

// Generate writes the Go models of the runtime model to OutputDir. An
// error leaves OutputDir unchanged, except an error reporting that the scanned
// packages do not compile with the complete models written to OutputDir.
func Generate(options Options) error {
	if options.Model == nil {
		return fmt.Errorf("model is required")
	}
	if options.OutputDir == "" {
		return fmt.Errorf("output directory is required")
	}
	return ormgen.GenerateGo(options.Model, options.OutputDir, options.PackageName, options.Scan)
}
