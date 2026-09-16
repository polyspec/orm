package ormgen

import "github.com/polyspec/orm/engine/schema"

// RenderCreateDDL renders an apply-safe schema from the canonical manifest.
// The SQL text remains inside the ORM repository; consumers receive no dialect
// selection or DDL contract.
func RenderCreateDDL(manifest *schema.Manifest, dialect string) (string, error) {
	return renderCreateDDL(manifest, dialect)
}

// SplitSQL separates the apply-safe renderer output into ordered statements.
// It preserves quoted and dialect-specific semicolons.
func SplitSQL(text string) []string { return splitSQL(text) }
