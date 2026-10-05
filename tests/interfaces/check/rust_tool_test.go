package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/polyspec/orm/internal/testcase"
)

// TestBuildRustReturnsBuiltExecutable는 buildRust가 cargo가 실제로 만든 symbol
// 도구를 돌려주는지 확인한다. Makefile은 모든 cargo 명령에 CARGO_TARGET_DIR을
// 주므로 도구는 tests/interfaces/rust/target이 아니라 그 directory에 생긴다.
func TestBuildRustReturnsBuiltExecutable(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	root, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	target := t.TempDir()
	t.Setenv("CARGO_TARGET_DIR", target)
	var tool string
	if err := testcase.RunLong("interfaces/rust-build", func(c *testcase.Case) (err error) {
		tool, err = buildRust(c, root)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(target, "debug", "orm-interface-symbols"); tool != want {
		t.Fatalf("buildRust = %s, want the executable cargo built in CARGO_TARGET_DIR %s", tool, want)
	}
	if info, err := os.Stat(tool); err != nil || info.IsDir() {
		t.Fatalf("buildRust returned %s, which is not a built executable: %v", tool, err)
	}
}
