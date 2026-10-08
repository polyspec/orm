package orm

import (
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/polyspec/orm/engine/ir"
)

var (
	sqliteDateTimeText = regexp.MustCompile(`^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})?$`)
	sqliteDateText     = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
)

// sqliteTimeValue writes a datetime or date value in the text form SQLite
// stores, so a string value compares equal to the stored value. A datetime
// string with an offset is converted to the connection time zone.
func (d *DB) sqliteTimeValue(v any, colType string) (any, error) {
	switch x := v.(type) {
	case time.Time:
		if colType == "date" {
			return x.In(d.location).Format("2006-01-02"), nil
		}
		return v, nil
	case string:
		if colType == "date" {
			if !sqliteDateText.MatchString(x) {
				return nil, invalidTimeText(x, colType)
			}
			if _, err := time.Parse("2006-01-02", x); err != nil {
				return nil, invalidTimeText(x, colType)
			}
			return x, nil
		}
		m := sqliteDateTimeText.FindStringSubmatch(x)
		if m == nil {
			return nil, invalidTimeText(x, colType)
		}
		text := m[1] + " " + m[2] + "." + m[3] + strings.Repeat("0", 6-len(m[3]))
		if m[4] == "" {
			if _, err := time.Parse("2006-01-02 15:04:05.000000", text); err != nil {
				return nil, invalidTimeText(x, colType)
			}
			return text, nil
		}
		zone := m[4]
		if zone == "Z" {
			zone = "+00:00"
		}
		t, err := time.Parse("2006-01-02 15:04:05.000000-07:00", text+zone)
		if err != nil {
			return nil, invalidTimeText(x, colType)
		}
		return t.In(d.location).Format("2006-01-02 15:04:05.000000"), nil
	}
	return v, nil
}

func invalidTimeText(v, colType string) error {
	form := "YYYY-MM-DD HH:MM:SS[.ffffff][Z|±HH:MM]"
	if colType == "date" {
		form = "YYYY-MM-DD"
	}
	return &ir.Error{Code: CodeCodecEncode, Msg: fmt.Sprintf("%s value %q is not %s", colType, v, form)}
}
