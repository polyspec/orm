package schema

import (
	"fmt"
	"regexp"
	"slices"
	"sort"
	"strings"
	"unicode"
)

// AuditLog names the tables that audit triggers write to and the transaction
// setting that carries the current operation id.
//
//	%% orm:audit_log operation=core.operation(seq, operation_uuid) context=platform.operation_id change=core.operation_change(operation_seq, change_operation, site_id, table_name, entity_key, old_value, new_value)
type AuditLog struct {
	Operation AuditTable `json:"operation"`
	Context   string     `json:"context"`
	Change    AuditTable `json:"change"`
}

// AuditTable is a physical table and the ordered columns an audit directive
// names on it.
type AuditTable struct {
	Table   string   `json:"table"`
	Columns []string `json:"columns"`
}

// Audit declares a database audit trigger on one entity.
//
//	%% orm:audit entity=service mode=changes site=site_id redact=secret.token
type Audit struct {
	Entity string     `json:"entity"`
	Mode   string     `json:"mode"`
	Site   string     `json:"site,omitempty"`
	Redact [][]string `json:"redact,omitempty"`
}

// Audit operation and change column positions.
const (
	AuditOperationSeq = iota
	AuditOperationUUID
)

const (
	AuditChangeOperationSeq = iota
	AuditChangeOperation
	AuditChangeSite
	AuditChangeTable
	AuditChangeEntityKey
	AuditChangeOldValue
	AuditChangeNewValue
)

var (
	reAuditTable   = regexp.MustCompile(`^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\(([^()]*)\)$`)
	reAuditContext = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.]{0,63}$`)
	reAuditSegment = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
)

// AuditEntity returns the audit declared for an entity.
func (m *Manifest) AuditEntity(name string) *Audit {
	for i := range m.Audits {
		if m.Audits[i].Entity == name {
			return &m.Audits[i]
		}
	}
	return nil
}

// auditTable reads table(column, ...). The tables are references like the
// target of %% orm:foreign: they may belong to another manifest installed on
// the same connection, so only the syntax and the column count are checked.
func auditTable(x *ORMDirective, option string, width int) (AuditTable, error) {
	match := reAuditTable.FindStringSubmatch(x.Args[option])
	if match == nil {
		return AuditTable{}, &BuildError{x.Line, "%% orm:audit_log: " + fmt.Sprintf("%s must be table(column, ...)", option)}
	}
	columns := splitDirectiveList(match[2])
	if len(columns) != width {
		return AuditTable{}, &BuildError{x.Line, "%% orm:audit_log: " + fmt.Sprintf("%s needs %d columns", option, width)}
	}
	for _, column := range columns {
		if !reAuditSegment.MatchString(column) {
			return AuditTable{}, &BuildError{x.Line, "%% orm:audit_log: " + fmt.Sprintf("%s has an invalid column %s", option, column)}
		}
	}
	if duplicate := firstDuplicate(columns); duplicate != "" {
		return AuditTable{}, &BuildError{x.Line, "%% orm:audit_log: " + fmt.Sprintf("%s repeats column %s", option, duplicate)}
	}
	return AuditTable{Table: match[1], Columns: columns}, nil
}

func (m *Manifest) addAuditLog(x *ORMDirective) error {
	if m.AuditLog != nil {
		return &BuildError{x.Line, "%% orm:audit_log: declared more than once"}
	}
	for _, option := range []string{"operation", "context", "change"} {
		if x.Args[option] == "" {
			return &BuildError{x.Line, "%% orm:audit_log: " + option + " is required"}
		}
	}
	operation, err := auditTable(x, "operation", 2)
	if err != nil {
		return err
	}
	change, err := auditTable(x, "change", 7)
	if err != nil {
		return err
	}
	if operation.Table == change.Table {
		return &BuildError{x.Line, "%% orm:audit_log: operation and change must be different tables"}
	}
	if !reAuditContext.MatchString(x.Args["context"]) {
		return &BuildError{x.Line, "%% orm:audit_log: invalid context " + x.Args["context"]}
	}
	m.AuditLog = &AuditLog{Operation: operation, Context: x.Args["context"], Change: change}
	return nil
}

func (m *Manifest) addAudit(x *ORMDirective) error {
	name := x.Args["entity"]
	e := m.Entities[name]
	if e == nil {
		return &BuildError{x.Line, "%% orm:audit: unknown entity " + name}
	}
	if m.AuditEntity(name) != nil {
		return &BuildError{x.Line, "%% orm:audit: entity " + name + " is declared more than once"}
	}
	mode := x.Args["mode"]
	if mode != "changes" && mode != "operations" {
		return &BuildError{x.Line, "%% orm:audit: mode must be changes or operations"}
	}
	audit := Audit{Entity: name, Mode: mode, Site: x.Args["site"]}
	if audit.Site != "" && e.Column(audit.Site) == nil {
		return &BuildError{x.Line, "%% orm:audit: " + fmt.Sprintf("unknown column %s.%s", name, audit.Site)}
	}
	if value, ok := x.Args["redact"]; ok {
		for _, item := range strings.Split(value, ",") {
			path := strings.Split(item, ".")
			for _, segment := range path {
				if !reAuditSegment.MatchString(segment) {
					return &BuildError{x.Line, "%% orm:audit: invalid redact path " + item}
				}
			}
			if e.Column(path[0]) == nil {
				return &BuildError{x.Line, "%% orm:audit: " + fmt.Sprintf("unknown column %s.%s", name, path[0])}
			}
			for _, previous := range audit.Redact {
				n := min(len(previous), len(path))
				if slices.Equal(previous[:n], path[:n]) {
					return &BuildError{x.Line, "%% orm:audit: redact paths overlap: " + item}
				}
			}
			audit.Redact = append(audit.Redact, path)
		}
	}
	m.Audits = append(m.Audits, audit)
	return nil
}

// finishAudits checks the declarations that depend on each other and sorts
// the audits by entity.
func (m *Manifest) finishAudits(first *ORMDirective) error {
	if len(m.Audits) == 0 {
		return nil
	}
	if m.AuditLog == nil {
		return &BuildError{first.Line, "%% orm:audit requires %% orm:audit_log"}
	}
	for _, audit := range m.Audits {
		table := m.Entities[audit.Entity].Table
		if table == m.AuditLog.Operation.Table || table == m.AuditLog.Change.Table {
			return &BuildError{first.Line, "%% orm:audit: the audit log table " + table + " cannot be audited"}
		}
	}
	sort.Slice(m.Audits, func(i, j int) bool { return m.Audits[i].Entity < m.Audits[j].Entity })
	return nil
}

func firstDuplicate(values []string) string {
	seen := map[string]bool{}
	for _, value := range values {
		if seen[value] {
			return value
		}
		seen[value] = true
	}
	return ""
}

// splitORMFields splits directive options on white space outside parentheses, so
// `operation=core.operation(seq, operation_uuid)` stays one option.
func splitORMFields(body string) []string {
	var fields []string
	var current strings.Builder
	depth := 0
	flush := func() {
		if current.Len() > 0 {
			fields = append(fields, current.String())
			current.Reset()
		}
	}
	for _, r := range body {
		switch {
		case r == '(':
			depth++
		case r == ')' && depth > 0:
			depth--
		case unicode.IsSpace(r) && depth == 0:
			flush()
			continue
		}
		current.WriteRune(r)
	}
	flush()
	return fields
}
