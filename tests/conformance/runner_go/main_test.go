package main

import (
	"errors"
	"testing"

	"github.com/polyspec/orm/internal/testcase"
	"github.com/polyspec/orm/packages/orm-go/model"
)

func TestPickRejectsUnselectedField(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	row := model.Author().SetName("present")
	defer func() {
		if recover() == nil {
			t.Fatal("unselected field was rendered as SQL NULL")
		}
	}()
	_ = pick(row, "name", "read_count")
}

func TestUnexpectedVectorErrorAndWriteTransaction(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	cause := errors.New("invalid row")
	_, err := executeVector("invalid", func() (any, error) { return nil, cause }, nil)
	if !errors.Is(err, cause) {
		t.Fatalf("unexpected vector error was altered: %v", err)
	}
	called := false
	result, err := executeVector("write", func() (any, error) { return 7, nil }, func(task func() error) error {
		called = true
		return task()
	})
	if err != nil || !called || result != 7 {
		t.Fatalf("write vector did not use its transaction: value=%v error=%v called=%t", result, err, called)
	}
}

func TestBindRenderingRejectsInvalidBytes(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	for _, input := range []any{
		[]byte{0xff},
		"\xff",
		[]byte("ORM-AES2\x00"),
		"ORM-AES2broken",
		"4f524d2d4145533200bad",
	} {
		t.Run("invalid", func(t *testing.T) {
			defer func() {
				if recover() == nil {
					t.Fatalf("invalid bind %v was rendered", input)
				}
			}()
			_ = norm(input)
		})
	}
	frame := append([]byte("ORM-AES2\x00"), make([]byte, 12+16)...)
	if got := norm(frame); got != "$AES" {
		t.Fatalf("valid encrypted bytes rendered as %v", got)
	}
}

func TestVectorSelection(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	uri, selected, err := parseArgs([]string{"-dsn", "sqlite://x", "-vector", "relations", "-vector", "columns"})
	if err != nil || uri != "sqlite://x" || len(selected) != 2 || !selected["relations"] || !selected["columns"] {
		t.Fatalf("parseArgs = %q %v %v", uri, selected, err)
	}
	if _, all, err := parseArgs([]string{"-dsn", "sqlite://x"}); err != nil || all != nil {
		t.Fatalf("parseArgs without -vector = %v %v", all, err)
	}
	for _, args := range [][]string{
		{},
		{"-vector", "relations"},
		{"-dsn", "sqlite://x", "-vector"},
		{"-dsn", "sqlite://x", "-vector", ""},
		{"-dsn", "sqlite://x", "-vector", "a", "-vector", "a"},
		{"-dsn", "sqlite://x", "-dsn", "sqlite://y"},
		{"-dsn", "sqlite://x", "--vector", "a"},
	} {
		if _, _, err := parseArgs(args); err == nil {
			t.Fatalf("parseArgs(%q) was accepted", args)
		}
	}
	declared := []declaredVector{{name: "a"}, {name: "b"}, {name: "c"}}
	got, err := selectVectors(declared, map[string]bool{"c": true, "a": true})
	if err != nil || len(got) != 2 || got[0].name != "a" || got[1].name != "c" {
		t.Fatalf("selectVectors = %v %v", got, err)
	}
	if got, err := selectVectors(declared, nil); err != nil || len(got) != 3 {
		t.Fatalf("selectVectors without a selection = %v %v", got, err)
	}
	if _, err := selectVectors(declared, map[string]bool{"a": true, "missing": true}); err == nil || err.Error() != "unknown vector missing" {
		t.Fatalf("unknown vector = %v", err)
	}
}
