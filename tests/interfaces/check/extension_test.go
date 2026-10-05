package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/polyspec/orm/internal/testcase"
)

// TestExtensionDeclarations는 extension(PHP 확장 php-extension)의 확인이 기록된 stub을 받아들이고, 공통
// contract와 다른 stub, extension이 적지 않은 adapter, 다른 symbol snapshot을 거부하는지 확인한다. 각 경우는
// stub과 snapshot을 이 test의 임시 root에 복사해 그것을 고친다.
func TestExtensionDeclarations(t *testing.T) {
	c := testcase.Start(t, testcase.Process)
	if _, err := exec.LookPath("php"); err != nil {
		t.Fatalf("php CLI is required; tool tests never skip")
	}
	repo, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	var m Manifest
	readJSON(filepath.Join(repo, "contracts/interfaces.json"), &m)
	e, ok := m.Extensions["php-extension"]
	if !ok {
		t.Fatal("contracts/interfaces.json declares no php-extension")
	}
	stub, err := os.ReadFile(filepath.Join(repo, e.Roots[0], "orm_dbspec.stub.php"))
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := os.ReadFile(filepath.Join(repo, e.Symbols))
	if err != nil {
		t.Fatal(err)
	}
	// check는 stub과 snapshot을 고친 임시 root에서 extension을 확인한다. php.php는 저장소의 것을 쓴다.
	check := func(stubSource, snapshotSource string, manifest Manifest) error {
		root := t.TempDir()
		for path, content := range map[string]string{filepath.Join(e.Roots[0], "orm_dbspec.stub.php"): stubSource, e.Symbols: snapshotSource} {
			if err := os.MkdirAll(filepath.Dir(filepath.Join(root, path)), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(root, path), []byte(content), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		// extract는 toolRoot의 php.php를 실행하므로 임시 root에도 같은 자리에 둔다.
		tool, err := os.ReadFile(filepath.Join(repo, "tests/interfaces/php.php"))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(filepath.Join(root, "tests/interfaces"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, "tests/interfaces/php.php"), tool, 0o644); err != nil {
			t.Fatal(err)
		}
		return checkExtension(c, root, "php-extension", manifest.Extensions["php-extension"], manifest, nil, false)
	}
	if err := check(string(stub), string(snapshot), m); err != nil {
		t.Fatalf("the recorded stub and snapshot are refused: %v", err)
	}
	for name, mutation := range map[string]struct {
		stub, snapshot string
		manifest       func(Manifest) Manifest
		want           string
	}{
		"a return type that differs from the contract": {
			stub: strings.Replace(string(stub), "public static function emit(Document $document): string", "public static function emit(Document $document): ?string", 1),
			want: "php-extension/Dbspec.emit",
		},
		"a missing result field": {
			stub: strings.Replace(string(stub), "    public string $externalText;\n", "", 1),
			want: "php-extension/DbspecManifest: missing externalText",
		},
		"an adapter that the extension does not list": {
			manifest: func(m Manifest) Manifest {
				// rule slice는 원래 manifest와 배열을 함께 쓰므로 복사해서 고친다.
				m.Rules = append([]Rule{}, m.Rules...)
				for i := range m.Rules {
					if m.Rules[i].ID == "Model.gets" {
						native := map[string]Native{}
						for k, v := range m.Rules[i].Native {
							native[k] = v
						}
						native["php-extension"] = native["php"]
						m.Rules[i].Native = native
					}
				}
				return m
			},
			want: "Model.gets has a php-extension adapter that the extension does not list",
		},
		"a snapshot that differs from the declarations": {
			snapshot: strings.Replace(string(snapshot), "public readonly int", "public readonly string", 1),
			want:     "php-extension: changed",
		},
	} {
		stubSource, snapshotSource, manifest := string(stub), string(snapshot), m
		if mutation.stub != "" {
			stubSource = mutation.stub
		}
		if mutation.snapshot != "" {
			snapshotSource = mutation.snapshot
		}
		if mutation.manifest != nil {
			manifest = mutation.manifest(m)
		}
		err := check(stubSource, snapshotSource, manifest)
		if err == nil || !strings.Contains(err.Error(), mutation.want) {
			t.Errorf("%s: want an error with %q, got %v", name, mutation.want, err)
		}
	}
}
