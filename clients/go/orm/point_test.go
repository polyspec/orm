package orm

import (
	"math"
	"testing"
)

func TestPointTextAndParse(t *testing.T) {
	for _, text := range []string{"POINT(1.25 -2)", "(1.25,-2)"} {
		p, err := ParsePoint(text)
		if err != nil || p != (Point{1.25, -2}) {
			t.Fatalf("ParsePoint(%q) = %#v, %v", text, p, err)
		}
		got, err := PointText(p)
		if err != nil || got != "POINT(1.25 -2)" {
			t.Fatalf("PointText = %q, %v", got, err)
		}
	}
	if got, _ := PointText(Point{math.Copysign(0, -1), 0}); got != "POINT(0 0)" {
		t.Fatalf("negative zero=%q", got)
	}
	for _, text := range []string{"POINT(1)", "POINT(1 NaN)", "POINT(1 2 3)"} {
		if _, err := ParsePoint(text); err == nil {
			t.Fatalf("ParsePoint(%q) accepted", text)
		}
	}
}
