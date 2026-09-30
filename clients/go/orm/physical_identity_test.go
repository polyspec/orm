package orm

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

func TestPhysicalIdentityVectors(t *testing.T) {
	started := time.Now()
	t.Log("RUN physical_identity")
	defer func() {
		elapsed := time.Since(started)
		t.Logf("DONE physical_identity %s", elapsed)
		if elapsed > 3*time.Second {
			t.Fatal("identity test deadline exceeded")
		}
	}()
	data, err := os.ReadFile("../../../contracts/fixtures/physical_identities.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		ID    string     `json:"id"`
		Parts [4]*string `json:"parts"`
		Key   string     `json:"key"`
		Error string     `json:"error"`
	}
	if err = json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) != 10 {
		t.Fatal("missing physical identity vectors")
	}
	seen := make(map[string]bool)
	for _, c := range cases {
		if c.ID == "" || seen[c.ID] {
			t.Fatal("duplicate or empty vector identity")
		}
		seen[c.ID] = true
		t.Run(c.ID, func(t *testing.T) {
			identity, err := NewPhysicalIdentity(c.Parts[0], c.Parts[1], *c.Parts[2], c.Parts[3])
			if c.Error != "" {
				if err == nil || err.Error() != c.Error {
					t.Fatalf("expected safe rejection, got %v", err)
				}
				return
			}
			if err != nil || identity.Key() != c.Key {
				t.Fatalf("identity mismatch: %v", err)
			}
			parts := identity.Parts()
			for i := range parts {
				if (parts[i] == nil) != (c.Parts[i] == nil) || (parts[i] != nil && *parts[i] != *c.Parts[i]) {
					t.Fatal("changed component")
				}
			}
			*c.Parts[2] = "changed"
			*parts[2] = "changed"
			if identity.Key() != c.Key || *identity.Parts()[2] == "changed" {
				t.Fatal("aliased input or output")
			}
		})
	}
	for _, name := range []string{strings.Repeat("x", 1025), strings.Repeat("한", 342), string([]byte{0xff})} {
		if _, err := NewPhysicalIdentity(nil, nil, name, nil); err == nil {
			t.Fatal("invalid encoding/size accepted")
		}
	}
	if _, err := NewPhysicalIdentity(nil, nil, strings.Repeat("x", 1024), nil); err != nil {
		t.Fatal(err)
	}
}
