package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/polyspec/orm/internal/testcase"
)

func TestGetsCountUsesDedicatedGroupedRowsInEveryClient(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	// go test는 test를 package directory(tests/interfaces/check)에서 실행하므로 저장소 root는 세 단계 위다.
	directory, err := os.Getwd()
	if err != nil {
		t.Fatalf("cannot read the working directory of the interface test: %v", err)
	}
	root := filepath.Clean(filepath.Join(directory, "../../.."))
	var manifest Manifest
	readJSON(filepath.Join(root, "contracts/interfaces.json"), &manifest)
	for _, rule := range manifest.Rules {
		if rule.ID != "Model.getsCount" {
			continue
		}
		if rule.Output != "GroupRows" {
			t.Fatalf("getsCount common output = %q, want GroupRows", rule.Output)
		}
		for _, language := range []string{"go", "php", "rust", "typescript", "python"} {
			native, ok := rule.Native[language]
			if !ok {
				t.Errorf("getsCount has no %s native signature", language)
				continue
			}
			if !strings.Contains(native.Signature, "GroupRows") || strings.Contains(native.Signature, "Collection") {
				t.Errorf("getsCount %s native signature returns a model collection: %q", language, native.Signature)
			}
		}
		return
	}
	t.Fatal("getsCount common rule is missing")
}
