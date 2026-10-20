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
	bin    string
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
			checkCaseResult(t, c.ID, got, err, c.Expect)
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
		t.Fatalf("FLOWMARK %s is no Go build (%v); run make orm-install-flowmark, which installs the flowmark %s pinned in tests/markdown/flowmark.version", bin, err, pin)
	}
	if info.Main.Path != flowmarkModule || info.Main.Version != pin {
		t.Fatalf("FLOWMARK %s is %q %q, not the pinned %s %s; run make orm-install-flowmark, or give FLOWMARK a build of a flowmark checkout at that revision", bin, info.Main.Path, info.Main.Version, flowmarkModule, pin)
	}
	return bin
}

var listening = regexp.MustCompile(`^\[serve\] listening on 127\.0\.0\.1:([0-9]+) for the corpus (.+)$`)

// serve installs corpus/ as a new corpus, starts its server, and connects to it. When the test ends,
// it closes the connection, stops the server, and waits for it to finish.
func serve(t *testing.T, bin string) *served {
	t.Helper()
	c := testcase.Of(t)
	s := &served{bin: bin, corpus: "conformance"}
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
			testcase.Close(t, s.db)
		}
		if err := cmd.Process.Signal(os.Interrupt); err != nil && !errors.Is(err, os.ErrProcessDone) {
			if err := cmd.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
				t.Errorf("kill flowmark serve: %v", err)
			}
		}
		// The interrupted server ends with an exit status, which is the expected end of it; Wait reports
		// only an error that is not an exit status, such as a failure of the wait itself.
		if err := cmd.Wait(); err != nil {
			var exit *exec.ExitError
			if !errors.As(err, &exit) {
				t.Errorf("wait for flowmark serve: %v", err)
			}
		}
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
			return markdownmodel.People().Connect(s.db).Creates([]*markdownmodel.PeopleModel{bob, cara}, 2)
		},
		"insert_rows_tasks": func(s *served) (any, error) {
			rows := []*markdownmodel.TasksModel{
				markdownmodel.Tasks().SetOwner("P1").SetTitle("write spec").SetPoints(3).SetDue(day("2026-10-01")),
				markdownmodel.Tasks().SetOwner("P1").SetTitle("review").SetPoints(5).SetDue(nil),
				markdownmodel.Tasks().SetOwner("P2").SetTitle("ship").SetPoints(8).SetDue(day("2026-10-05")),
			}
			return markdownmodel.Tasks().Connect(s.db).Creates(rows, len(rows))
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
				return nil, fmt.Errorf("the transaction ended with %w, not its callback's error", err)
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
					return fmt.Errorf("the savepoint ended with %w, not its callback's error", err)
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
				if cerr := db.Close(); cerr != nil {
					return nil, cerr
				}
			}
			return nil, err
		},
		"connect_token_mismatch": func(s *served) (any, error) {
			db, err := markdownmodel.Connect(s.dsn(s.corpus, strings.Repeat("0", 32)), orm.Config{})
			if err == nil {
				if cerr := db.Close(); cerr != nil {
					return nil, cerr
				}
			}
			return nil, err
		},
		// order_nulls reads the age of every person in both orders: NULL sorts before every value ascending and
		// after every value descending (docs/spec/dialects.md DIA-156).
		"order_nulls": func(s *served) (any, error) {
			out := map[string]any{}
			for _, order := range []string{"asc", "desc"} {
				q := markdownmodel.People().Connect(s.db).RemoveAllColumns().AddColumnAge()
				if order == "asc" {
					q.OrderByAgeAsc()
				} else {
					q.OrderByAgeDesc()
				}
				rows, err := q.Gets()
				if err != nil {
					return nil, err
				}
				out[order] = rows.ToArray()
			}
			return out, nil
		},
		// order_random reads every key with orderByRandom, which is supported and not seeded, so the case answers
		// the keys sorted (DIA-182).
		"order_random": func(s *served) (any, error) {
			rows, err := markdownmodel.People().Connect(s.db).RemoveAllColumns().OrderByRandom().Gets()
			if err != nil {
				return nil, err
			}
			var keys []string
			for _, m := range rows.All() {
				keys = append(keys, m.GetId())
			}
			slices.Sort(keys)
			return keys, nil
		},
		// primary_key_case inserts the key t3, which equals T3 without regard to case: a plain insert is
		// DUPLICATE_KEY, and an on_duplicate insert meets T3, which keeps its key (DIA-164).
		"primary_key_case": func(s *served) (any, error) {
			_, dup := markdownmodel.Tasks().Connect(s.db).SetId("t3").SetOwner("P2").SetTitle("dup").SetPoints(1).Create()
			if _, err := markdownmodel.Tasks().Connect(s.db).SetId("t3").SetOwner("P2").SetTitle("ship it").SetPoints(8).
				Duplication(markdownmodel.Tasks().SetTitle("ship it")).Create(); err != nil {
				return nil, err
			}
			met, err := markdownmodel.Tasks().Connect(s.db).RemoveAllColumns().AddColumnTitle().Id("T3").Get()
			if err != nil {
				return nil, err
			}
			n, err := markdownmodel.Tasks().Connect(s.db).GetCount()
			if err != nil {
				return nil, err
			}
			return map[string]any{"duplicate": orm.ErrorCode(dup), "met": met.ToArray(), "count": n}, nil
		},
		// tuple_in compares two columns with a list of value groups, IN and NOT IN (DIA-168).
		"tuple_in": func(s *served) (any, error) {
			pairs := []markdownmodel.TasksIdWithOwner{{Id: "T1", Owner: "P1"}, {Id: "T3", Owner: "P1"}}
			in, err := markdownmodel.Tasks().Connect(s.db).RemoveAllColumns().TupleIdWithOwner(pairs).OrderByIdAsc().Gets()
			if err != nil {
				return nil, err
			}
			notIn, err := markdownmodel.Tasks().Connect(s.db).RemoveAllColumns().NeTupleIdWithOwner(pairs).OrderByIdAsc().Gets()
			if err != nil {
				return nil, err
			}
			return map[string]any{"in": in.ToArray(), "not_in": notIn.ToArray()}, nil
		},
		// subquery_aggregate adds the sum of each person's task points as a scalar Sub aggregate, and reads the
		// people that own a task through an IN subquery (DIA-168).
		"subquery_aggregate": func(s *served) (any, error) {
			rows, err := markdownmodel.People().Connect(s.db).RemoveAllColumns().
				AddColumnTaskPoints(func(p *markdownmodel.PeopleModel) orm.Model {
					return markdownmodel.Tasks().SumPoints().OwnerEqId(p)
				}).OrderByIdAsc().Gets()
			if err != nil {
				return nil, err
			}
			sums := []any{}
			for _, m := range rows.All() {
				v := m.GetTaskPoints()
				if v != nil {
					n, err := orm.AsInt64(v)
					if err != nil {
						return nil, err
					}
					v = n
				}
				sums = append(sums, []any{m.GetId(), v})
			}
			owners, err := markdownmodel.People().Connect(s.db).RemoveAllColumns().
				Id(markdownmodel.Tasks().AddColumnOwner()).OrderByIdAsc().Gets()
			if err != nil {
				return nil, err
			}
			return map[string]any{"sums": sums, "owners": owners.ToArray()}, nil
		},
		// scalar_column_subquery adds the title of each person's first task, a column subquery with limit 1 and
		// an order by the primary key; without the limit it is IR_INVALID (DIA-169).
		"scalar_column_subquery": func(s *served) (any, error) {
			rows, err := markdownmodel.People().Connect(s.db).RemoveAllColumns().
				AddColumnFirstTask(func(p *markdownmodel.PeopleModel) orm.Model {
					return markdownmodel.Tasks().RemoveAllColumns().AddColumnTitle().OwnerEqId(p).OrderByIdAsc().Limit(0, 1)
				}).OrderByIdAsc().Gets()
			if err != nil {
				return nil, err
			}
			firsts := []any{}
			for _, m := range rows.All() {
				firsts = append(firsts, []any{m.GetId(), m.GetFirstTask()})
			}
			_, unlimited := markdownmodel.People().Connect(s.db).RemoveAllColumns().
				AddColumnFirstTask(func(p *markdownmodel.PeopleModel) orm.Model {
					return markdownmodel.Tasks().RemoveAllColumns().AddColumnTitle().OwnerEqId(p).OrderByIdAsc()
				}).OrderByIdAsc().Gets()
			return map[string]any{"first": firsts, "unlimited": orm.ErrorCode(unlimited)}, nil
		},
		// column_pairs compares two columns: varchar with varchar meet, i32 with varchar do not and are
		// OPERATOR_NOT_ALLOWED (DIA-170).
		"column_pairs": func(s *served) (any, error) {
			p := markdownmodel.People()
			meet, err := markdownmodel.Tasks().Connect(s.db).JoinOwnerWithId(p).TitleNeName(p).GetCount()
			if err != nil {
				return nil, err
			}
			q := markdownmodel.People()
			_, refused := markdownmodel.Tasks().Connect(s.db).JoinOwnerWithId(q).PointsEqName(q).GetCount()
			return map[string]any{"meet": meet, "refused": orm.ErrorCode(refused)}, nil
		},
		// contains is Lk: A-Z and a-z without regard to case, % literal (DIA-171).
		"contains": func(s *served) (any, error) {
			out := map[string]any{}
			for name, p := range map[string]string{"fold": "ANN", "literal": "%"} {
				rows, err := markdownmodel.People().Connect(s.db).RemoveAllColumns().LkName(p).OrderByIdAsc().Gets()
				if err != nil {
					return nil, err
				}
				out[name] = rows.ToArray()
			}
			return out, nil
		},
		// contains_binary is Lb: compared by code point (DIA-172).
		"contains_binary": func(s *served) (any, error) {
			out := map[string]any{}
			for name, p := range map[string]string{"exact": "Ann", "folded": "ann"} {
				rows, err := markdownmodel.People().Connect(s.db).RemoveAllColumns().LbName(p).OrderByIdAsc().Gets()
				if err != nil {
					return nil, err
				}
				out[name] = rows.ToArray()
			}
			return out, nil
		},
		// now_truncated reads the default now of joined, a datetime(0), which holds no fraction, and compares
		// it with a relative time function past 9999-12-31, which is NULL and matches no row (DIA-173).
		"now_truncated": func(s *served) (any, error) {
			m, err := markdownmodel.People().Connect(s.db).Id("P1").Get()
			if err != nil {
				return nil, err
			}
			far := orm.SecondsLater(1000000000000000)
			gt, err := markdownmodel.People().Connect(s.db).AndGtJoined(far).GetCount()
			if err != nil {
				return nil, err
			}
			le, err := markdownmodel.People().Connect(s.db).AndLeJoined(far).GetCount()
			if err != nil {
				return nil, err
			}
			return map[string]any{"fraction": m.GetJoined().Nanosecond(), "out_of_range": []any{gt, le}}, nil
		},
		// index_read reads through the column of the index ix_tasks_owner, which the corpus derives in memory (DIA-176).
		"index_read": func(s *served) (any, error) {
			rows, err := markdownmodel.Tasks().Connect(s.db).RemoveAllColumns().Owner("P2").Gets()
			if err != nil {
				return nil, err
			}
			return rows.ToArray(), nil
		},
		// force_index names an index, which the corpus does not name: CAPABILITY_UNSUPPORTED (DIA-186).
		"force_index": func(s *served) (any, error) {
			return markdownmodel.Tasks().Connect(s.db).ForceIndexIxTasksOwner().Owner("P1").Gets()
		},
		// unavailable_table writes a heading of another table into tasks.flowmark.md, which is format.block:
		// a read of tasks fails CONSTRAINT naming the file, and reads again once the file is restored (DIA-190).
		"unavailable_table": func(s *served) (any, error) {
			path := filepath.Join(s.dir, "tasks.flowmark.md")
			b, err := os.ReadFile(path)
			if err != nil {
				return nil, err
			}
			if err := os.WriteFile(path, append(bytes.Clone(b), []byte("\n## people row P1\n")...), 0o644); err != nil {
				return nil, err
			}
			_, broken := markdownmodel.Tasks().Connect(s.db).GetCount()
			if err := os.WriteFile(path, b, 0o644); err != nil {
				return nil, err
			}
			n, err := markdownmodel.Tasks().Connect(s.db).GetCount()
			if err != nil {
				return nil, err
			}
			return map[string]any{"broken": orm.ErrorCode(broken), "names_file": broken != nil && strings.Contains(broken.Error(), "tasks.flowmark.md"), "restored": n}, nil
		},
		// install_refuses_aes installs a catalog with an aes column, a schema error on a corpus (DIA-178).
		"install_refuses_aes": func(s *served) (any, error) {
			return refusedInstall(s, "aes")
		},
		// install_refuses_audit installs a catalog with an audit setting, a schema error on a corpus (DIA-179).
		"install_refuses_audit": func(s *served) (any, error) {
			return refusedInstall(s, "audit")
		},
	}
}

// installRefusal is the code that flowmark install prints when it refuses a catalog: "flowmark install: <CODE>: ...".
var installRefusal = regexp.MustCompile(`^flowmark install: ([A-Z_]+):`)

// refusedInstall installs tests/markdown/refused/<name>.dbs as the catalog of a new corpus and answers the code of
// its refusal, {"error": code}; an install that succeeds answers {"error": null}.
func refusedInstall(s *served, name string) (answer any, err error) {
	catalog, err := os.ReadFile(filepath.Join(conformanceDir, "refused", name+".dbs"))
	if err != nil {
		return nil, err
	}
	root, err := os.MkdirTemp("", "orm-markdown-refused-")
	if err != nil {
		return nil, err
	}
	defer func() {
		if rerr := os.RemoveAll(root); rerr != nil && err == nil {
			answer, err = nil, fmt.Errorf("remove the temporary catalog %s: %w", root, rerr)
		}
	}()
	dir := filepath.Join(root, name)
	if err := os.MkdirAll(filepath.Join(dir, "dbspec"), 0o755); err != nil {
		return nil, err
	}
	if err := os.WriteFile(filepath.Join(dir, "dbspec", name+".dbs"), catalog, 0o644); err != nil {
		return nil, err
	}
	out, err := exec.Command(s.bin, "install", dir).CombinedOutput()
	if err == nil {
		return map[string]any{"error": nil}, nil
	}
	m := installRefusal.FindSubmatch(out)
	if m == nil {
		return nil, fmt.Errorf("flowmark install %s: %w, without a refusal code:\n%s", dir, err, out)
	}
	return map[string]any{"error": string(m[1])}, nil
}

// normalize is the value read back after the result was written as JSON: it has the same shape as expect in cases.json.
// checkCaseResult checks the result of a conformance case: an error must carry an
// orm code, which is the result, and the normalized result must equal expect.
func checkCaseResult(t *testing.T, id string, got any, err error, expect any) {
	t.Helper()
	if err != nil {
		code := orm.ErrorCode(err)
		if code == "" {
			t.Fatalf("%s failed without an orm code: %v", id, err)
		}
		got = map[string]any{"error": code}
	}
	actual := normalize(t, got)
	if !reflect.DeepEqual(actual, expect) {
		t.Fatalf("%s: got %s, want %s (error %v)", id, jsonText(t, actual), jsonText(t, expect), err)
	}
}

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

func jsonText(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("result %#v: %v", v, err)
	}
	return string(b)
}
