// Package stmtdiff는 두 statement 목록의 차이를 statement 단위로 적는다: 기대 목록에 없는데 나온
// statement(+)와 기대했는데 나오지 않은 statement(-)를 그 kind와 text와 함께, 순서를 지키는 가장 긴 공통
// 부분(LCS) 밖의 것만 적는다. conformance 비교와 interface 결과 비교가 차이를 "다르다"가 아니라 어느
// statement가 더해지거나 빠졌는지로 보고하는 데 쓴다.
package stmtdiff

import (
	"fmt"
	"sort"
	"strings"
)

// Statement는 비교할 statement 하나다. Key가 같은 두 statement는 같은 것이다. Kind와 Text는 보고에 쓴다.
type Statement struct {
	Kind string
	Text string
	Key  string
}

// Change는 차이 하나다. Added면 나왔지만 기대하지 않은 statement, 아니면 기대했지만 나오지 않은 statement다.
// Index는 그 statement가 속한 목록(Added면 나온 목록, 아니면 기대 목록)에서의 1부터 센 위치다.
type Change struct {
	Added     bool
	Index     int
	Statement Statement
}

func (c Change) String() string {
	sign := "-"
	if c.Added {
		sign = "+"
	}
	text := c.Statement.Text
	if text != "" {
		text = " " + text
	}
	return fmt.Sprintf("%s #%d %s%s", sign, c.Index, c.Statement.Kind, text)
}

// Diff는 expected를 got으로 바꾸는 가장 작은 더하기와 빼기를 expected의 순서대로 돌려준다.
func Diff(expected, got []Statement) []Change {
	n, m := len(expected), len(got)
	lcs := make([][]int, n+1)
	for i := range lcs {
		lcs[i] = make([]int, m+1)
	}
	for i := n - 1; i >= 0; i-- {
		for j := m - 1; j >= 0; j-- {
			if expected[i].Key == got[j].Key {
				lcs[i][j] = lcs[i+1][j+1] + 1
			} else {
				lcs[i][j] = max(lcs[i+1][j], lcs[i][j+1])
			}
		}
	}
	var changes []Change
	i, j := 0, 0
	for i < n || j < m {
		switch {
		case i < n && j < m && expected[i].Key == got[j].Key:
			i, j = i+1, j+1
		case j < m && (i == n || lcs[i][j+1] >= lcs[i+1][j]):
			changes = append(changes, Change{Added: true, Index: j + 1, Statement: got[j]})
			j++
		default:
			changes = append(changes, Change{Index: i + 1, Statement: expected[i]})
			i++
		}
	}
	return changes
}

// Summary는 차이를 kind의 무리(group이 kind에 준 이름)마다 센 한 줄이다. 예: "+2 transaction-control, -1 model".
func Summary(changes []Change, group func(kind string) string) string {
	counts := map[string]int{}
	for _, change := range changes {
		sign := "-"
		if change.Added {
			sign = "+"
		}
		counts[sign+" "+group(change.Statement.Kind)]++
	}
	keys := make([]string, 0, len(counts))
	for key := range counts {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	parts := make([]string, len(keys))
	for index, key := range keys {
		parts[index] = fmt.Sprintf("%s%d %s", key[:1], counts[key], key[2:])
	}
	return strings.Join(parts, ", ")
}

// Group은 statement event의 kind를 무리로 나눈다(docs/usage.md "Statement events"): model, transaction-control,
// schema, utility. 그 밖의 kind는 그대로 둔다.
func Group(kind string) string {
	switch kind {
	case "select", "insert", "update", "delete":
		return "model"
	case "begin", "commit", "rollback", "savepoint", "release", "rollback_to":
		return "transaction-control"
	case "schema", "utility":
		return kind
	}
	return kind
}
