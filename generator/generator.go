// Package generator exposes the canonical schema-to-client generator.
package generator

import (
	"fmt"

	"github.com/polyspec/orm/engine/schema"
	"github.com/polyspec/orm/internal/ormgen"
)

// Language identifies a generated client language.
type Language string

const (
	Go         Language = "go"
	PHP        Language = "php"
	Rust       Language = "rust"
	TypeScript Language = "typescript"
)

// Options describes one deterministic generation request.
type Options struct {
	Manifest  *schema.Manifest
	Language  Language
	OutputDir string
	Namespace string
	// PackageName selects the Go package name. It is ignored by other languages.
	PackageName string
}

// Generate writes the client described by the canonical manifest to OutputDir.
// The language generator and its naming rules remain owned by the ORM.
func Generate(options Options) error {
	if options.Manifest == nil {
		return fmt.Errorf("manifest is required")
	}
	if options.OutputDir == "" {
		return fmt.Errorf("output directory is required")
	}
	switch options.Language {
	case Go:
		return ormgen.GenerateGo(options.Manifest, options.OutputDir, options.PackageName)
	case PHP:
		return ormgen.GeneratePHP(options.Manifest, options.OutputDir, options.Namespace)
	case Rust:
		return ormgen.GenerateRust(options.Manifest, options.OutputDir)
	case TypeScript:
		return ormgen.GenerateTypeScript(options.Manifest, options.OutputDir)
	default:
		return fmt.Errorf("unsupported language %q", options.Language)
	}
}
