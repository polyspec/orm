package recipe

import (
	"bytes"
	"encoding/json"
	"fmt"
	"slices"
	"sort"
	"strings"
	"sync"
)

// annotations are the keys that the format holds for the reader of the recipe or for the runner of the step, which no op
// reads; expect_unnamed is the outcome of a driver with unnamed parameters, which this runtime does not have.
var annotations = map[string]bool{"op": true, "only": true, "reason": true, "expect_unnamed": true}

// stepReads records the keys of a step that a run reads (FCV-4): a key that the helper never reads asserts nothing, so an
// unread key fails the case by name.
type stepReads struct {
	mu   sync.Mutex
	op   string
	keys map[string]bool
	read map[string]bool
}

// newStepReads holds the keys of the raw step; a raw value that is no object holds none.
func newStepReads(raw json.RawMessage) *stepReads {
	var fields map[string]json.RawMessage
	reads := &stepReads{keys: map[string]bool{}, read: map[string]bool{}}
	if err := json.Unmarshal(raw, &fields); err != nil {
		return reads
	}
	for key, value := range fields {
		reads.keys[key] = true
		if key == "op" {
			_ = json.Unmarshal(value, &reads.op)
		}
	}
	return reads
}

// mark records that the run read key. A nil set records nothing: a step that a helper builds is no step of a recipe.
func (r *stepReads) mark(key string) {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.read[key] = true
}

// check fails by name on a key of the step that the run did not read.
func (r *stepReads) check() error {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	unread := []string{}
	for key := range r.keys {
		if !annotations[key] && !r.read[key] {
			unread = append(unread, key)
		}
	}
	if len(unread) == 0 {
		return nil
	}
	sort.Strings(unread)
	return fmt.Errorf("the helper did not read %s of %s", strings.Join(unread, ", "), r.op)
}

// checkOutcome fails by name on a key of the outcome of an expected error that the helper neither compares nor read in its
// op. A nil set holds a step that a helper builds, whose outcome is compared the same.
func (r *stepReads) checkOutcome(expected map[string]any, op string, compared ...string) error {
	unread := []string{}
	for key := range expected {
		if slices.Contains(compared, key) || r.markedOutcome(key) {
			continue
		}
		unread = append(unread, "expect."+key)
	}
	if len(unread) == 0 {
		return nil
	}
	sort.Strings(unread)
	return fmt.Errorf("the helper did not read %s of %s", strings.Join(unread, ", "), op)
}

// markedOutcome says whether the op read the key of its outcome itself.
func (r *stepReads) markedOutcome(key string) bool {
	if r == nil {
		return false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.read["expect."+key]
}

// k records the read of key and returns the step, so that a read of a field names its key: s.k("as").As.
func (s databaseStep) k(key string) databaseStep {
	s.reads.mark(key)
	return s
}

// k records the read of key and returns the query.
func (q chainQuery) k(key string) chainQuery {
	q.reads.mark(key)
	return q
}

// k records the read of key and returns the step.
func (s chainStep) k(key string) chainStep {
	s.reads.mark(key)
	return s
}

// k records the read of key and returns the step.
func (s step) k(key string) step {
	s.reads.mark(key)
	return s
}

// decodeOutcome decodes the outcome of a step into the fields that its op compares, and fails by name on any other key.
func decodeOutcome(raw json.RawMessage, into any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	return decoder.Decode(into)
}
