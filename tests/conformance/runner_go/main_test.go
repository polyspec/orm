package main

import (
	"errors"
	"testing"

	"github.com/polyspec/orm/clients/go/model"
)

func TestPickRejectsUnselectedField(t *testing.T) {
	row := model.Author().SetName("present")
	defer func() {
		if recover() == nil {
			t.Fatal("unselected field was rendered as SQL NULL")
		}
	}()
	_ = pick(row, "name", "read_count")
}

func TestUnexpectedVectorErrorAndWriteTransaction(t *testing.T) {
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
