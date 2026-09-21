package ormgen

import (
	"strings"
	"testing"

	"github.com/polyspec/orm/engine/schema"
)

func TestMySQLBooleanLiteralDefaultUsesNumericSyntax(t *testing.T) {
	diagram, err := schema.Parse("erDiagram\n  flags {\n    bigint id PK\n    boolean enabled \"=true\"\n    boolean disabled \"=false\"\n  }\n")
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := schema.Build(diagram)
	if err != nil {
		t.Fatal(err)
	}
	ddl, err := renderDDL(manifest, "mysql")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(ddl, "`enabled` boolean NOT NULL DEFAULT 1") || !strings.Contains(ddl, "`disabled` boolean NOT NULL DEFAULT 0") {
		t.Fatalf("MySQL boolean default is not numeric:\n%s", ddl)
	}
	if strings.Contains(ddl, "DEFAULT '1'") || strings.Contains(ddl, "DEFAULT 'true'") {
		t.Fatalf("MySQL boolean default is quoted:\n%s", ddl)
	}
}

func TestMySQLLongConstraintNamesAreBoundedAndStable(t *testing.T) {
	original := "fk_core.service_module_connection_consumer_service_module_seq_provider_service_module_seq_module_connection_seq"
	name := boundedIdentifier(original, "mysql")
	if len(name) > 64 {
		t.Fatalf("constraint name length=%d: %q", len(name), name)
	}
	if name != boundedIdentifier(original, "mysql") {
		t.Fatal("constraint shortening is not deterministic")
	}
}

func TestMySQLCheckExpressionsAreExplicitlyBoolean(t *testing.T) {
	diagram := `erDiagram
  audit {
    bigint id PK
    varchar(32) host_operation
    varchar(32) read_metadata "?"
  }
  %% check audit audit_read_metadata : CASE WHEN ` + "`host_operation`" + ` = 'audit.list' THEN ` + "`read_metadata`" + ` IS NOT NULL ELSE ` + "`read_metadata`" + ` IS NULL END
`
	d, err := schema.Parse(diagram)
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := schema.Build(d)
	if err != nil {
		t.Fatal(err)
	}
	ddl, err := renderDDL(manifest, "mysql")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(ddl, "CHECK ((CASE WHEN `host_operation` = 'audit.list' THEN `read_metadata` IS NOT NULL ELSE `read_metadata` IS NULL END) <> 0)") {
		t.Fatalf("MySQL CHECK was not explicitly boolean: %s", ddl)
	}
}
