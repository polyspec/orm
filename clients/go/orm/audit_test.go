package orm

import (
	"strings"
	"testing"
)

func validAuditSpec() AuditSpec {
	return AuditSpec{
		Table: "module.records", Mode: AuditChanges, SiteColumn: "site_id", EntityKeyColumns: []string{"account_id", "id"},
		RedactedPaths: [][]string{{"details", "private"}}, OperationTable: "core.operation", OperationSeqColumn: "seq", OperationUUIDColumn: "operation_uuid", OperationContextKey: "platform.operation_id",
		ChangeTable: "core.operation_change", ChangeOperationSeqColumn: "operation_seq", ChangeOperationColumn: "change_operation", ChangeSiteColumn: "site_id", ChangeTableColumn: "table_name", ChangeEntityKeyColumn: "entity_key", ChangeOldValueColumn: "old_value", ChangeNewValueColumn: "new_value",
	}
}

func TestValidateAuditSpecRejectsInvalidDeclarations(t *testing.T) {
	for name, mutate := range map[string]func(*AuditSpec){
		"missing table":      func(s *AuditSpec) { s.Table = "records" },
		"missing mode":       func(s *AuditSpec) { s.Mode = "" },
		"missing change key": func(s *AuditSpec) { s.ChangeOperationSeqColumn = "" },
		"invalid redaction":  func(s *AuditSpec) { s.RedactedPaths = [][]string{{"details", "private.value"}} },
	} {
		t.Run(name, func(t *testing.T) {
			spec := validAuditSpec()
			mutate(&spec)
			if err := validateAuditSpec(spec); err == nil {
				t.Fatal("invalid audit declaration accepted")
			}
		})
	}
}

func TestAuditFunctionBodyCapturesChangedFieldsAndRedactsPaths(t *testing.T) {
	body := auditFunctionBody(validAuditSpec())
	for _, fragment := range []string{
		"current_setting('platform.operation_id', true)",
		"jsonb_object_agg(key, value)",
		"jsonb_build_object('redacted', true",
		"'details','private'",
		"TG_OP",
	} {
		if !strings.Contains(body, fragment) {
			t.Fatalf("audit function body missing %q: %s", fragment, body)
		}
	}
}
