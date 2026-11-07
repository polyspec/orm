package testdb

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

// corpusName is the name of the corpus of a recipe case; each case has a directory of its own.
const corpusName = "recipe"

var flowmarkListening = regexp.MustCompile(`^\[serve\] listening on 127\.0\.0\.1:([0-9]+) for the corpus (.+)$`)

// NewCorpus installs the documents of the dbspec set at setPath as a new corpus, starts the flowmark server of FLOWMARK on
// it and returns its markdown DSN. The server stops when the test ends (FCV-3).
func NewCorpus(t testing.TB, setPath string) string {
	t.Helper()
	dsn, _ := NewCorpusDir(t, setPath)
	return dsn
}

// NewCorpusDir is NewCorpus that also returns the directory of the corpus.
func NewCorpusDir(t testing.TB, setPath string) (string, string) {
	t.Helper()
	c := testcase.Of(t)
	bin := os.Getenv("FLOWMARK")
	if bin == "" {
		t.Fatal("FLOWMARK is required; make orm-install-flowmark builds the version that tests/markdown/flowmark.version pins")
	}
	dir := filepath.Join(t.TempDir(), corpusName)
	if setPath == "" {
		// A recipe of no fixture, or one whose steps install it, starts as a case database with no table.
		if err := os.MkdirAll(filepath.Join(dir, "dbspec"), 0o755); err != nil {
			t.Fatal(err)
		}
	} else if err := copySet(setPath, filepath.Join(dir, "dbspec")); err != nil {
		t.Fatalf("copy the set %s: %v", setPath, err)
	}
	if out, err := exec.CommandContext(c.Context(), bin, "install", dir).CombinedOutput(); err != nil {
		t.Fatalf("flowmark install: %v\n%s", err, out)
	}
	c.Step("corpus %s installed", dir)
	server := StartFlowmark(t, bin, dir, corpusName)
	return "markdown://127.0.0.1:" + server.Port + "/" + corpusName + "?token=" + server.Token, dir
}

// FlowmarkServer is a running flowmark server: its port, its token, and what it wrote to its standard error.
type FlowmarkServer struct {
	Port   string
	Token  string
	Stderr *bytes.Buffer
}

// StartFlowmark starts the flowmark at bin on the installed corpus at dir, named corpus. The server stops when the test
// ends, after every cleanup that the test registers later.
func StartFlowmark(t testing.TB, bin, dir, corpus string) FlowmarkServer {
	t.Helper()
	// A corpus of a test is disposable, as a test database server is: a commit does not wait for the disk.
	cmd := exec.Command(bin, "serve", dir, "--port", "0", "--synchronous", "off", "--tx-idle-ms", "600000")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := cmd.Process.Signal(os.Interrupt); err != nil && !errors.Is(err, os.ErrProcessDone) {
			if err := cmd.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
				t.Errorf("kill flowmark serve: %v", err)
			}
		}
		// The interrupted server ends with an exit status, which is its expected end.
		var exit *exec.ExitError
		if err := cmd.Wait(); err != nil && !errors.As(err, &exit) {
			t.Errorf("wait for flowmark serve: %v", err)
		}
	})
	line, err := bufio.NewReader(stdout).ReadString('\n')
	m := flowmarkListening.FindStringSubmatch(strings.TrimSuffix(line, "\n"))
	if err != nil || m == nil || m[2] != corpus {
		t.Fatalf("flowmark serve printed %q (%v), not its listening line; stderr:\n%s", line, err, stderr.String())
	}
	var file struct {
		Token string `json:"token"`
	}
	b, err := os.ReadFile(filepath.Join(dir, ".flowmark", "server.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, &file); err != nil {
		t.Fatalf("server.json: %v", err)
	}
	return FlowmarkServer{Port: m[1], Token: file.Token, Stderr: &stderr}
}

// copySet copies the set file and its documents into the dbspec directory of a corpus.
func copySet(setPath, into string) error {
	if err := os.MkdirAll(into, 0o755); err != nil {
		return err
	}
	text, err := os.ReadFile(setPath)
	if err != nil {
		return err
	}
	var set struct {
		Documents []string `json:"documents"`
		External  []string `json:"external"`
	}
	if err := json.Unmarshal(text, &set); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(into, filepath.Base(setPath)), text, 0o644); err != nil {
		return err
	}
	for _, document := range append(set.Documents, set.External...) {
		body, err := os.ReadFile(filepath.Join(filepath.Dir(setPath), document))
		if err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(into, document), body, 0o644); err != nil {
			return err
		}
	}
	return nil
}
