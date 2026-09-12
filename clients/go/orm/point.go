package orm

import (
	"fmt"
	"math"
	"strconv"
	"strings"

	"github.com/polyspec/orm/engine/ir"
)

// Point is the common two-dimensional point value: X followed by Y.
type Point [2]float64

// PointText returns the database transport form used by every dialect.
func PointText(p Point) (string, error) {
	if math.IsNaN(p[0]) || math.IsInf(p[0], 0) || math.IsNaN(p[1]) || math.IsInf(p[1], 0) {
		return "", &ir.Error{Code: CodeCodecEncode, Msg: "point coordinates must be finite"}
	}
	return "POINT(" + pointNumber(p[0]) + " " + pointNumber(p[1]) + ")", nil
}

func postgresPointText(p Point) (string, error) {
	if _, err := PointText(p); err != nil {
		return "", err
	}
	return "(" + pointNumber(p[0]) + "," + pointNumber(p[1]) + ")", nil
}

func pointNumber(v float64) string {
	if v == 0 {
		return "0"
	}
	return strconv.FormatFloat(v, 'g', -1, 64)
}

// ParsePoint accepts MySQL WKT and PostgreSQL point output.
func ParsePoint(v any) (Point, error) {
	if p, ok := v.(Point); ok {
		if _, err := PointText(p); err != nil {
			return Point{}, err
		}
		return p, nil
	}
	s := strings.TrimSpace(AsString(v))
	if strings.HasPrefix(strings.ToUpper(s), "POINT(") && strings.HasSuffix(s, ")") {
		s = strings.TrimSpace(s[6 : len(s)-1])
	} else if strings.HasPrefix(s, "(") && strings.HasSuffix(s, ")") {
		s = strings.TrimSpace(s[1 : len(s)-1])
	}
	s = strings.ReplaceAll(s, ",", " ")
	parts := strings.Fields(s)
	if len(parts) != 2 {
		return Point{}, &ir.Error{Code: CodeCodecDecode, Msg: fmt.Sprintf("point requires two coordinates: %q", AsString(v))}
	}
	var p Point
	for i := range p {
		n, err := strconv.ParseFloat(parts[i], 64)
		if err != nil || math.IsNaN(n) || math.IsInf(n, 0) {
			return Point{}, &ir.Error{Code: CodeCodecDecode, Msg: fmt.Sprintf("point coordinate %d is not finite: %q", i, parts[i])}
		}
		p[i] = n
	}
	return p, nil
}

// AsPoint converts a database result. Dialects return a validated point text.
func AsPoint(v any) Point { p, _ := ParsePoint(v); return p }
