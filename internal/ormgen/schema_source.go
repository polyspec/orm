package ormgen

import (
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/polyspec/orm/engine/schema"
)

const schemaMetadataPrefix = "-- orm-schema-v1 "

// loadSchemaSource resolves one schema source without changing it. Supported
// sources are Mermaid, manifest JSON, ormgen DDL, and db:<dsn>.
func loadSchemaSource(source, driver string) (*schema.Manifest, error) {
	if strings.HasPrefix(source, "db:") {
		return loadDatabaseSchema(strings.TrimPrefix(source, "db:"), driver)
	}
	b, err := os.ReadFile(source)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", source, err)
	}
	ext := strings.ToLower(filepath.Ext(source))
	switch ext {
	case ".mmd", ".mermaid":
		return buildMermaidSource(source, b)
	case ".json":
		return schema.Load(b)
	case ".sql":
		return manifestFromDDL(source, b)
	default:
		trimmed := strings.TrimSpace(string(b))
		switch {
		case strings.HasPrefix(trimmed, "erDiagram"):
			return buildMermaidSource(source, b)
		case strings.HasPrefix(trimmed, "{"):
			return schema.Load(b)
		case strings.Contains(string(b), schemaMetadataPrefix):
			return manifestFromDDL(source, b)
		default:
			return nil, fmt.Errorf("MIGRATION_SOURCE: %s: cannot detect mmd, json, or ormgen sql", source)
		}
	}
}

func buildMermaidSource(path string, b []byte) (*schema.Manifest, error) {
	d, err := schema.Parse(string(b))
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	m, err := schema.Build(d)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return m, nil
}

func manifestMetadata(m *schema.Manifest) (string, error) {
	b, err := m.MarshalIndent()
	if err != nil {
		return "", err
	}
	return schemaMetadataPrefix + base64.RawStdEncoding.EncodeToString(b) + "\n", nil
}

func manifestFromDDL(path string, b []byte) (*schema.Manifest, error) {
	for _, line := range strings.Split(string(b), "\n") {
		if !strings.HasPrefix(line, schemaMetadataPrefix) {
			continue
		}
		encoded := strings.TrimSpace(strings.TrimPrefix(line, schemaMetadataPrefix))
		decoded, err := base64.RawStdEncoding.DecodeString(encoded)
		if err != nil {
			return nil, fmt.Errorf("MIGRATION_SOURCE: %s: invalid orm-schema-v1 metadata: %w", path, err)
		}
		m, err := schema.Load(decoded)
		if err != nil {
			return nil, fmt.Errorf("MIGRATION_SOURCE: %s: invalid embedded manifest: %w", path, err)
		}
		return m, nil
	}
	return nil, fmt.Errorf("MIGRATION_SOURCE_LOSS: %s has no orm-schema-v1 metadata; SQL cannot represent codec styles or relation options", path)
}

func loadDatabaseSchema(raw, dialect string) (*schema.Manifest, error) {
	if raw == "" {
		return nil, fmt.Errorf("MIGRATION_SOURCE: db: requires a DSN")
	}
	dsn, err := parseToolDSN(raw)
	if err != nil {
		return nil, err
	}
	if dsn.dialect != dialect {
		return nil, fmt.Errorf("MIGRATION_CONFIG: db source %s is %s, not %s", dsn.redacted(), dsn.dialect, dialect)
	}
	db, _, err := openToolDB(raw)
	if err != nil {
		return nil, err
	}
	defer db.Close()
	m, err := liveManifest(db, dsn.dialect)
	if err != nil {
		return nil, fmt.Errorf("MIGRATION_INTROSPECT: driver=%s dsn=%s: %w", dsn.dialect, dsn.redacted(), err)
	}
	return m, nil
}
