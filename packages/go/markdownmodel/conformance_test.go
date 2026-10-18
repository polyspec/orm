//go:build markdown

// The markdown conformance runs on a flowmark server, so it builds only with the tag markdown, which make
// markdown-conformance-check/go passes with FLOWMARK; the test run of ./packages/go/... leaves it out.

package markdownmodel_test

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	"debug/buildinfo"

	"github.com/polyspec/orm/packages/go/markdownmodel"
	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

// conformanceDir is the directory of the shared suite: cases.json, flowmark.version, corpus/.
// The working directory of go test is this package directory.
const conformanceDir = "../../../tests/markdown"

// flowmarkModule is the module path that must be the main module of the build FLOWMARK points to.
const flowmarkModule = "github.com/polyspec/flowmark"

// served is the flowmark server that the test started and its corpus.
type served struct {
	db     *orm.DB
	dir    string
	corpus string
	port   string
	token  string
}

// caseFunc runs one case and returns the result value that README defines. The error of its code
// becomes the result {"error": code}.
type caseFunc func(s *served) (any, error)

// TestMarkdownConformance runs every case of tests/markdown/cases.json, in order, against one server of the flowmark build that FLOWMARK
// points to, which must be the build pinned by flowmark.version;
// if it is missing or a different build, the test fails (it is not skipped).
func TestMarkdownConformance(t *testing.T) {
	testcase.Start(t, testcase.Process)
	bin := pinnedFlowmark(t)
	cases := loadCases(t)
	funcs := conformanceCases()
	var ids []string
	for _, c := range cases {
		ids = append(ids, c.ID)
	}
	var missing, extra []string
	for _, id := range ids {
		if funcs[id] == nil {
			missing = append(missing, id)
		}
	}
	for id := range funcs {
		if !slices.Contains(ids, id) {
			extra = append(extra, id)
		}
	}
	if len(missing) > 0 || len(extra) > 0 {
		slices.Sort(extra)
		t.Fatalf("cases.json and the Go cases differ: missing in Go %v, not in cases.json %v", missing, extra)
	}
	s := serve(t, bin)
	for _, c := range cases {
		ok := t.Run(c.ID, func(t *testing.T) {
			testcase.Start(t, testcase.Database)
			got, err := funcs[c.ID](s)
			if err != nil {
				code := orm.ErrorCode(err)
				if code == "" {
					t.Fatalf("%s failed without an orm code: %v", c.ID, err)
				}
				got = map[string]any{"error": code}
			}
			actual := normalize(t, got)
			if !reflect.DeepEqual(actual, c.Expect) {
				t.Fatalf("%s: got %s, want %s (error %v)", c.ID, jsonText(actual), jsonText(c.Expect), err)
			}
		})
		if !ok {
			// Later cases read the corpus state that earlier cases produced, so it stops at the first failure.
			t.FailNow()
		}
	}
}

type conformanceCase struct {
	ID     string `json:"id"`
	Expect any    `json:"expect"`
}

func loadCases(t *testing.T) []conformanceCase {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(conformanceDir, "cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Cases []conformanceCase `json:"cases"`
	}
	if err := json.Unmarshal(b, &doc); err != nil {
		t.Fatalf("cases.json: %v", err)
	}
	seen := map[string]bool{}
	for _, c := range doc.Cases {
		if c.ID == "" || seen[c.ID] {
			t.Fatalf("cases.json: case id %q is empty or repeated", c.ID)
		}
		seen[c.ID] = true
	}
	return doc.Cases
}

// pinnedFlowmark is the flowmark binary that FLOWMARK points to. It fails the test if the binary's build info
// is not the flowmark.version of the module.
func pinnedFlowmark(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(conformanceDir, "flowmark.version"))
	if err != nil {
		t.Fatal(err)
	}
	pin := strings.TrimSpace(string(b))
	bin := os.Getenv("FLOWMARK")
	if bin == "" {
		t.Fatalf("FLOWMARK is not set; run make markdown-conformance-check, which passes the path of the flowmark %s pinned in tests/markdown/flowmark.version", pin)
	}
	info, err := buildinfo.ReadFile(bin)
	if err != nil {
		t.Fatalf("FLOWMARK %s is no Go build (%v); run make install-flowmark, which installs the flowmark %s pinned in tests/markdown/flowmark.version", bin, err, pin)
	}
	if info.Main.Path != flowmarkModule || info.Main.Version != pin {
		t.Fatalf("FLOWMARK %s is %q %q, not the pinned %s %s; run make install-flowmark, or give FLOWMARK a build of a flowmark checkout at that revision", bin, info.Main.Path, info.Main.Version, flowmarkModule, pin)
	}
	return bin
}

var listening = regexp.MustCompile(`^\[serve\] listening on 127\.0\.0\.1:([0-9]+) for the corpus (.+)$`)

// serve installs corpus/ as a new corpus, starts its server, and connects to it. When the test ends,
// it closes the connection, stops the server, and waits for it to finish.
func serve(t *testing.T, bin string) *served {
	t.Helper()
	c := testcase.Of(t)
	s := &served{corpus: "conformance"}
	s.dir = filepath.Join(t.TempDir(), s.corpus)
	if err := os.MkdirAll(filepath.Join(s.dir, "dbspec"), 0o755); err != nil {
		t.Fatal(err)
	}
	catalog, err := os.ReadFile(filepath.Join(conformanceDir, "corpus", "dbspec", "conformance.dbs"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.dir, "dbspec", "conformance.dbs"), catalog, 0o644); err != nil {
		t.Fatal(err)
	}
	c.Step("flowmark install %s", s.dir)
	if out, err := exec.CommandContext(c.Context(), bin, "install", s.dir).CombinedOutput(); err != nil {
		t.Fatalf("flowmark install: %v\n%s", err, out)
	}
	c.Step("flowmark serve %s --port 0", s.dir)
	cmd := exec.Command(bin, "serve", s.dir, "--port", "0")
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
		if s.db != nil {
			s.db.Close()
		}
		if err := cmd.Process.Signal(os.Interrupt); err != nil && !errors.Is(err, os.ErrProcessDone) {
			cmd.Process.Kill()
		}
		cmd.Wait()
	})
	line, err := bufio.NewReader(stdout).ReadString('\n')
	m := listening.FindStringSubmatch(strings.TrimSuffix(line, "\n"))
	if err != nil || m == nil || m[2] != s.corpus {
		t.Fatalf("flowmark serve printed %q (%v), not its listening line; stderr:\n%s", line, err, stderr.String())
	}
	s.port = m[1]
	var file struct {
		Token string `json:"token"`
	}
	b, err := os.ReadFile(filepath.Join(s.dir, ".flowmark", "server.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, &file); err != nil {
		t.Fatalf("server.json: %v", err)
	}
	s.token = file.Token
	db, err := markdownmodel.Connect(s.dsn(s.corpus, s.token), orm.Config{})
	if err != nil {
		t.Fatalf("connect: %v; stderr:\n%s", err, stderr.String())
	}
	s.db = db
	return s
}

func (s *served) dsn(corpus, token string) string {
	return fmt.Sprintf("markdown://127.0.0.1:%s/%s?token=%s", s.port, corpus, token)
}

func ptr[T any](v T) *T { return &v }

// day returns the text form of a date; the setter takes the text and the text is checked here.
func day(s string) *string {
	if _, err := time.Parse(time.DateOnly, s); err != nil {
		panic(err)
	}
	return &s
}

// errStop is the error the callback returns to roll the transaction back.
var errStop = errors.New("stop")

// conformanceCases is the function that runs each case for each id in cases.json.
func conformanceCases() map[string]caseFunc {
	return map[string]caseFunc{
		"insert_one": func(s *served) (any, error) {
			score, err := markdownmodel.People().Connect(s.db).SetName("Ann").SetEmail(ptr("ann@example.com")).SetAge(ptr(int32(30))).SetScore("1.50")
			if err != nil {
				return nil, err
			}
			m, err := score.Create()
			if err != nil {
				return nil, err
			}
			return map[string]any{"id": m.GetId()}, nil
		},
		"insert_rows": func(s *served) (any, error) {
			bob, err := markdownmodel.People().SetName("Bob").SetEmail(ptr("bob@example.com")).SetAge(ptr(int32(25))).SetScore("2.00")
			if err != nil {
				return nil, err
			}
			cara, err := markdownmodel.People().SetName("Cara").SetEmail(nil).SetAge(nil).SetScore("0.50")
			if err != nil {
				return nil, err
			}
			return markdownmodel.People().Connect(s.db).Creates([]*markdownmodel.PeopleModel{bob, cara})
		},
		"insert_rows_tasks": func(s *served) (any, error) {
			rows := []*markdownmodel.TasksModel{
				markdownmodel.Tasks().SetOwner("P1").SetTitle("write spec").SetPoints(3).SetDue(day("2026-10-01")),
				markdownmodel.Tasks().SetOwner("P1").SetTitle("review").SetPoints(5).SetDue(nil),
				markdownmodel.Tasks().SetOwner("P2").SetTitle("ship").SetPoints(8).SetDue(day("2026-10-05")),
			}
			return markdownmodel.Tasks().Connect(s.db).Creates(rows)
		},
		"insert_identity": func(s *served) (any, error) {
			m, err := markdownmodel.Logs().Connect(s.db).SetTask("T1").SetNote("started").Create()
			if err != nil {
				return nil, err
			}
			return map[string]any{"id": m.GetId()}, nil
		},
		"one": func(s *served) (any, error) {
			m, err := markdownmodel.People().Connect(s.db).RemoveAllColumns().AddColumnName().AddColumnEmail().AddColumnAge().AddColumnActive().AddColumnScore().Id("P1").Get()
			if err != nil {
				return nil, err
			}
			return m.ToArray(), nil
		},
		"one_no_rows": func(s *served) (any, error) {
			return markdownmodel.People().Connect(s.db).Id("P9").Get()
		},
		"all": func(s *served) (any, error) {
			rows, err := markdownmodel.People().Connect(s.db).RemoveAllColumns().AddColumnName().AddColumnAge().OrderByNameDesc().Gets()
			if err != nil {
				return nil, err
			}
			return rows.ToArray(), nil
		},
		"count": func(s *served) (any, error) {
			return markdownmodel.Tasks().Connect(s.db).Owner("P1").GetCount()
		},
		"group_count": func(s *served) (any, error) {
			rows, err := markdownmodel.Tasks().Connect(s.db).GroupByOwner().OrderByOwnerAsc().GetsCount()
			if err != nil {
				return nil, err
			}
			return rows.ToArray(), nil
		},
		"group_count_no_rows": func(s *served) (any, error) {
			rows, err := markdownmodel.Tasks().Connect(s.db).Owner("P9").GroupByOwner().OrderByOwnerAsc().GetsCount()
			if err != nil {
				return nil, err
			}
			return rows.ToArray(), nil
		},
		"sum": func(s *served) (any, error) {
			return markdownmodel.Tasks().Connect(s.db).SumPoints().GetSum()
		},
		"avg": func(s *served) (any, error) {
			return markdownmodel.People().Connect(s.db).AvgAge().GetAvg()
		},
		"paginate": func(s *served) (any, error) {
			page, err := markdownmodel.People().Connect(s.db).RemoveAllColumns().AddColumnName().OrderByNameAsc().GetsPage(2, 2)
			if err != nil {
				return nil, err
			}
			return map[string]any{"items": page.Items.ToArray(), "total_count": page.TotalCount, "total_pages": page.TotalPages}, nil
		},
		"join": func(s *served) (any, error) {
			rows, err := markdownmodel.Tasks().Connect(s.db).RemoveAllColumns().AddColumnTitle().
				JoinOwnerWithId(markdownmodel.People().RemoveAllColumns().AddColumnName()).
				OrderByTitleAsc().Gets()
			if err != nil {
				return nil, err
			}
			return rows.ToArray(), nil
		},
		"relation_many": func(s *served) (any, error) {
			m, err := markdownmodel.People().Connect(s.db).RemoveAllColumns().AddColumnName().
				Relations(markdownmodel.Tasks().RemoveAllColumns().AddColumnDue().MatchIdWithOwner().OrderByTitleAsc()).
				Id("P1").Get()
			if err != nil {
				return nil, err
			}
			return m.ToArray(), nil
		},
		"relation_one": func(s *served) (any, error) {
			m, err := markdownmodel.Tasks().Connect(s.db).RemoveAllColumns().AddColumnTitle().
				Relation(markdownmodel.People().RemoveAllColumns().AddColumnName().MatchOwnerWithId()).
				Id("T3").Get()
			if err != nil {
				return nil, err
			}
			return m.ToArray(), nil
		},
		"update": func(s *served) (any, error) {
			m, err := markdownmodel.People().Connect(s.db).Id("P2").Get()
			if err != nil {
				return nil, err
			}
			if _, err := m.SetAge(ptr(int32(26))).Update(); err != nil {
				return nil, err
			}
			m, err = markdownmodel.People().Connect(s.db).RemoveAllColumns().AddColumnAge().Id("P2").Get()
			if err != nil {
				return nil, err
			}
			return m.ToArray(), nil
		},
		"update_optimistic_conflict": func(s *served) (any, error) {
			stale, err := markdownmodel.People().Connect(s.db).Id("P2").Get()
			if err != nil {
				return nil, err
			}
			fresh, err := markdownmodel.People().Connect(s.db).Id("P2").Get()
			if err != nil {
				return nil, err
			}
			if _, err := fresh.SetName("Bobby").Update(); err != nil {
				return nil, err
			}
			return stale.SetAge(ptr(int32(27))).Update(true)
		},
		"insert_on_duplicate": func(s *served) (any, error) {
			m, err := markdownmodel.People().Connect(s.db).SetName("Ann B").SetEmail(ptr("ann@example.com")).
				Duplication(markdownmodel.People().SetName("Ann B")).Create()
			if err != nil {
				return nil, err
			}
			read, err := markdownmodel.People().Connect(s.db).Id("P1").Get()
			if err != nil {
				return nil, err
			}
			return map[string]any{"created": m.GetId(), "name": read.GetName()}, nil
		},
		"delete": func(s *served) (any, error) {
			m, err := markdownmodel.Tasks().Connect(s.db).Id("T2").Get()
			if err != nil {
				return nil, err
			}
			if err := m.Delete(); err != nil {
				return nil, err
			}
			return markdownmodel.Tasks().Connect(s.db).GetCount()
		},
		"delete_referenced": func(s *served) (any, error) {
			m, err := markdownmodel.Tasks().Connect(s.db).Id("T1").Get()
			if err != nil {
				return nil, err
			}
			return nil, m.Delete()
		},
		"soft_delete": func(s *served) (any, error) {
			m, err := markdownmodel.People().Connect(s.db).Id("P3").Get()
			if err != nil {
				return nil, err
			}
			if err := m.Delete(); err != nil {
				return nil, err
			}
			return markdownmodel.People().Connect(s.db).GetCount()
		},
		"restore": func(s *served) (any, error) {
			m, err := markdownmodel.People().Connect(s.db).SetId("P3").Restore()
			if err != nil {
				return nil, err
			}
			n, err := markdownmodel.People().Connect(s.db).GetCount()
			if err != nil {
				return nil, err
			}
			return map[string]any{"id": m.GetId(), "name": m.GetName(), "count": n}, nil
		},
		"transaction_commit": func(s *served) (any, error) {
			if err := s.db.Transaction(func() error {
				_, err := markdownmodel.Logs().SetTask("T3").SetNote("committed").Create()
				return err
			}); err != nil {
				return nil, err
			}
			return markdownmodel.Logs().Connect(s.db).GetCount()
		},
		"transaction_rollback": func(s *served) (any, error) {
			err := s.db.Transaction(func() error {
				if _, err := markdownmodel.Logs().SetTask("T3").SetNote("rolled back").Create(); err != nil {
					return err
				}
				return errStop
			})
			if !errors.Is(err, errStop) {
				return nil, fmt.Errorf("the transaction ended with %v, not its callback's error", err)
			}
			return markdownmodel.Logs().Connect(s.db).GetCount()
		},
		"savepoint_rollback": func(s *served) (any, error) {
			if err := s.db.Transaction(func() error {
				if _, err := markdownmodel.Logs().SetTask("T3").SetNote("outer").Create(); err != nil {
					return err
				}
				err := s.db.Transaction(func() error {
					if _, err := markdownmodel.Logs().SetTask("T3").SetNote("inner").Create(); err != nil {
						return err
					}
					return errStop
				})
				if !errors.Is(err, errStop) {
					return fmt.Errorf("the savepoint ended with %v, not its callback's error", err)
				}
				return nil
			}); err != nil {
				return nil, err
			}
			rows, err := markdownmodel.Logs().Connect(s.db).OrderByIdAsc().Gets()
			if err != nil {
				return nil, err
			}
			var notes []string
			for _, m := range rows.All() {
				notes = append(notes, m.GetNote())
			}
			return notes, nil
		},
		"read_only_write": func(s *served) (any, error) {
			return nil, s.db.Transaction(func() error {
				_, err := markdownmodel.Logs().SetTask("T3").SetNote("read only").Create()
				return err
			}, orm.ReadOnly())
		},
		"lock_update": func(s *served) (any, error) {
			var out any
			err := s.db.Transaction(func() error {
				m, err := markdownmodel.People().Connect(s.db).RemoveAllColumns().Id("P1").ForUpdate().Get()
				if err == nil {
					out = m.ToArray()
				}
				return err
			})
			return out, err
		},
		"lock_nowait": func(s *served) (any, error) {
			return nil, s.db.Transaction(func() error {
				_, err := markdownmodel.People().Connect(s.db).Id("P1").ForUpdateNoWait().Get()
				return err
			})
		},
		"get_query": func(s *served) (any, error) {
			return markdownmodel.People().Connect(s.db).GetQuery()
		},
		"isolation": func(s *served) (any, error) {
			return nil, s.db.Transaction(func() error { return nil }, orm.Isolation(orm.Serializable))
		},
		"write_conflict": func(s *served) (any, error) {
			err := s.db.Transaction(func() error {
				m, err := markdownmodel.People().Id("P1").Get()
				if err != nil {
					return err
				}
				if _, err := m.SetName("Ann C").Update(); err != nil {
					return err
				}
				// Edit from outside the engine: changes a file that the transaction writes, before commit.
				path := filepath.Join(s.dir, "people.flowmark.md")
				b, err := os.ReadFile(path)
				if err != nil {
					return err
				}
				if !bytes.Contains(b, []byte("Cara")) {
					return fmt.Errorf("%s holds no Cara to edit:\n%s", path, b)
				}
				return os.WriteFile(path, bytes.Replace(b, []byte("Cara"), []byte("Carol"), 1), 0o644)
			})
			read, rerr := markdownmodel.People().Connect(s.db).Id("P1").Get()
			if rerr != nil {
				return nil, rerr
			}
			return map[string]any{"error": orm.ErrorCode(err), "name": read.GetName()}, nil
		},
		// transaction_retry_commit runs a transaction that reads P1 and writes its own name back, with retry options,
		// and answers the commit's code (null when it commits) and how many times the callback ran: a commit that is
		// WRITE_CONFLICT is never retried, a DEADLOCK is (contracts/fixtures/ir_answers.json).
		"transaction_retry_commit": func(s *served) (any, error) {
			runs := 0
			err := s.db.Transaction(func() error {
				runs++
				m, err := markdownmodel.People().Id("P1").Get()
				if err != nil {
					return err
				}
				_, err = m.SetName(m.GetName()).Update()
				return err
			}, orm.Retry(3))
			var code any
			if err != nil {
				if orm.ErrorCode(err) == "" {
					return nil, err
				}
				code = orm.ErrorCode(err)
			}
			return map[string]any{"error": code, "runs": runs}, nil
		},
		"connect_corpus_mismatch": func(s *served) (any, error) {
			db, err := markdownmodel.Connect(s.dsn("other", s.token), orm.Config{})
			if err == nil {
				db.Close()
			}
			return nil, err
		},
		"connect_token_mismatch": func(s *served) (any, error) {
			db, err := markdownmodel.Connect(s.dsn(s.corpus, strings.Repeat("0", 32)), orm.Config{})
			if err == nil {
				db.Close()
			}
			return nil, err
		},
	}
}

// normalize is the value read back after the result was written as JSON: it has the same shape as expect in cases.json.
func normalize(t *testing.T, v any) any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("result %#v: %v", v, err)
	}
	var out any
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func jsonText(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}
