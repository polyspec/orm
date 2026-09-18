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

// RenderDDL renders the CREATE statements of a manifest for one dialect.
func RenderDDL(manifest *schema.Manifest, dialect string) (string, error) {
	return renderDDL(manifest, dialect)
}

// RenderDiff renders the migration between two manifests for one dialect.
func RenderDiff(from, to *schema.Manifest, dialect string, allowDestructive bool) (string, error) {
	return renderDiff(from, to, dialect, allowDestructive)
}

// RenderMigrationPlan renders the plan file of ormgen plan for two manifests.
func RenderMigrationPlan(from, to *schema.Manifest, dialect, id, name string) ([]byte, error) {
	return buildMigrationPlan(from, to, dialect, id, name)
}
