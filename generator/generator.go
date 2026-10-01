// Package generator writes the Go models of a dbspec document set; the
// orm-gen command and other programs call it.
package generator

import (
	"fmt"

	"github.com/polyspec/orm/engine/runtimemodel"
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

func (options Options) validate() error {
	if options.Model == nil {
		return fmt.Errorf("model is required")
	}
	if options.OutputDir == "" {
		return fmt.Errorf("output directory is required")
	}
	return nil
}

// Generate writes the Go models of the runtime model to OutputDir. The
// generated files of OutputDir are replaced after the scan converges; any
// other error leaves OutputDir unchanged. A *ScannedSourceError reports scanned
// packages that do not compile with the complete models written to OutputDir.
func Generate(options Options) error {
	if err := options.validate(); err != nil {
		return err
	}
	return generateGo(options.Model, options.OutputDir, options.PackageName, options.Scan)
}

// Check generates the models like Generate without changing OutputDir or its
// parent directory and returns one line for each generated file that differs,
// is missing, or is extra, ordered by path.
func Check(options Options) ([]string, error) {
	if err := options.validate(); err != nil {
		return nil, err
	}
	return checkGo(options.Model, options.OutputDir, options.PackageName, options.Scan)
}
