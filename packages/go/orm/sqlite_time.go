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
	sqliteTimeText     = regexp.MustCompile(`^(\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?$`)
	sqliteDateText     = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
)

// sqliteTimeValue writes a date, datetime or time value in the text form SQLite stores,
// so a string value compares equal to the stored value. A datetime or time has exactly
// precision fraction digits, as the column's CHECK requires: the digits past precision
// must be zero (an IR message writes six, protocol.md §5) and are dropped, and a
// non-zero digit there is no value of the column (CODEC_ENCODE). A datetime string with
// an offset is converted to the connection time zone.
func (d *DB) sqliteTimeValue(v any, colType string, precision int) (any, error) {
	switch x := v.(type) {
	case time.Time:
		switch colType {
		case "date":
			return x.In(d.location).Format("2006-01-02"), nil
		case "time":
			return fractionText(x.Format("15:04:05.000000"), 8, precision, x, colType)
		}
		return fractionText(x.In(d.location).Format("2006-01-02 15:04:05.000000"), 19, precision, x, colType)
	case string:
		switch colType {
		case "date":
			if !sqliteDateText.MatchString(x) {
				return nil, invalidTimeText(x, colType)
			}
			if _, err := time.Parse("2006-01-02", x); err != nil {
				return nil, invalidTimeText(x, colType)
			}
			return x, nil
		case "time":
			m := sqliteTimeText.FindStringSubmatch(x)
			if m == nil {
				return nil, invalidTimeText(x, colType)
			}
			text := m[1] + "." + m[2] + strings.Repeat("0", 6-len(m[2]))
			if _, err := time.Parse("15:04:05.000000", text); err != nil {
				return nil, invalidTimeText(x, colType)
			}
			return fractionText(text, 8, precision, x, colType)
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
			return fractionText(text, 19, precision, x, colType)
		}
		zone := m[4]
		if zone == "Z" {
			zone = "+00:00"
		}
		t, err := time.Parse("2006-01-02 15:04:05.000000-07:00", text+zone)
		if err != nil {
			return nil, invalidTimeText(x, colType)
		}
		return fractionText(t.In(d.location).Format("2006-01-02 15:04:05.000000"), 19, precision, x, colType)
	}
	return v, nil
}

// fractionText cuts text, whose first whole characters are the clock and whose fraction
// has six digits after a point, to precision fraction digits. It fails as CODEC_ENCODE
// naming value when a digit past precision is not zero.
func fractionText(text string, whole, precision int, value any, colType string) (string, error) {
	if precision < 0 || precision > 6 {
		return "", &ir.Error{Code: CodeInternal, Msg: fmt.Sprintf("%s bind precision %d is outside 0 to 6", colType, precision)}
	}
	fraction := text[whole+1:]
	if strings.Trim(fraction[precision:], "0") != "" {
		return "", &ir.Error{Code: CodeCodecEncode, Msg: fmt.Sprintf("%s value %v has a non-zero digit past its %d fraction digits", colType, value, precision)}
	}
	if precision == 0 {
		return text[:whole], nil
	}
	return text[:whole+1+precision], nil
}

func invalidTimeText(v, colType string) error {
	form := "YYYY-MM-DD HH:MM:SS[.ffffff][Z|±HH:MM]"
	switch colType {
	case "date":
		form = "YYYY-MM-DD"
	case "time":
		form = "HH:MM:SS[.ffffff]"
	}
	return &ir.Error{Code: CodeCodecEncode, Msg: fmt.Sprintf("%s value %q is not %s", colType, v, form)}
}
