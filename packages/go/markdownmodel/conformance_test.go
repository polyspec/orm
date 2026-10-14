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

// conformanceDir는 공유 suite의 directory다: cases.json, flowmark.version, corpus/.
// go test의 working directory는 이 package directory다.
const conformanceDir = "../../../tests/markdown"

// flowmarkModule은 FLOWMARK가 가리키는 build의 main module이어야 하는 module path다.
const flowmarkModule = "github.com/polyspec/flowmark"

// served는 test가 시작한 flowmark server와 그 corpus다.
type served struct {
	db     *orm.DB
	dir    string
	corpus string
	port   string
	token  string
}

// caseFunc는 case 하나를 실행하고 README가 정한 결과 값을 돌려준다. error는 그 code의
// {"error": code} 결과가 된다.
type caseFunc func(s *served) (any, error)

// TestMarkdownConformance는 tests/markdown/cases.json의 모든 case를 그 순서대로, FLOWMARK가
// 가리키는 flowmark build의 server 하나에 대해 실행한다. 그 build는 flowmark.version이 고정한
// build여야 하고, 없거나 다른 build이면 test는 실패한다(건너뛰지 않는다).
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
			// 뒤의 case는 앞 case가 만든 corpus 상태를 읽으므로 첫 실패에서 멈춘다.
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

// pinnedFlowmark는 FLOWMARK가 가리키는 flowmark binary다. binary의 build 정보가 flowmark
// module의 flowmark.version 판이 아니면 test를 실패시킨다.
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

// serve는 corpus/를 새 corpus로 install하고 그 server를 시작해 연결한다. test가 끝나면
// 연결을 닫고 server를 멈춘 뒤 끝나기를 기다린다.
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

func day(s string) *time.Time {
	d, err := time.Parse(time.DateOnly, s)
	if err != nil {
		panic(err)
	}
	return &d
}

// errStop는 transaction을 rollback시키려고 callback이 돌려주는 오류다.
var errStop = errors.New("stop")

// conformanceCases는 cases.json의 id마다 그 case를 실행하는 함수다.
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
			// date 값은 runtime value model의 text YYYY-MM-DD다(README "Results"). Go의 array form은
			// time.Time을 datetime text로 쓰므로 relation 행의 due를 그 text로 쓴다.
			tasks, err := orm.RelatedAs[*orm.Collection[*markdownmodel.TasksModel]](m.Orm_(), "tasks_models")
			if err != nil || tasks == nil {
				return nil, fmt.Errorf("P1 has no tasks_models collection (%v)", err)
			}
			items := []map[string]any{}
			for _, t := range tasks.All() {
				item := t.ToArray()
				if due := t.GetDue(); due != nil {
					item["due"] = due.Format(time.DateOnly)
				}
				items = append(items, item)
			}
			out := m.ToArray()
			out["tasks_models"] = items
			return out, nil
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
				// engine 밖의 편집: transaction이 쓸 file을 commit 전에 바꾼다.
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

// normalize는 결과를 JSON으로 썼다 읽은 값이다: cases.json의 expect와 같은 형태다.
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
