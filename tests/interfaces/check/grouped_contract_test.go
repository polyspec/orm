package main

import (
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/polyspec/orm/internal/testcase"
)

func TestGetsCountUsesDedicatedGroupedRowsInEveryClient(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate interface test")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(file), "../../.."))
	var manifest Manifest
	readJSON(filepath.Join(root, "contracts/interfaces.json"), &manifest)
	for _, rule := range manifest.Rules {
		if rule.ID != "Model.getsCount" {
			continue
		}
		if rule.Output != "GroupRows" {
			t.Fatalf("getsCount common output = %q, want GroupRows", rule.Output)
		}
		for _, language := range []string{"go", "php", "rust", "typescript"} {
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
