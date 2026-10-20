package orm

import (
	"context"
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/polyspec/orm/packages/go/engine/ir"
	"github.com/polyspec/orm/packages/go/engine/plan"
)

// cached is one plan-cache entry with the facts every execution needs.
type cached struct {
	key   uint64
	id    string
	plan  *plan.Plan
	scans map[*plan.Step]*scanInfo
	// shapes caches the row shape of each assemble (*plan.Assemble → *rowShape).
	shapes sync.Map
}

type scanInfo struct {
	n      int
	styled []styledScanCol
	bufs   sync.Pool
}

// scanBuf is the scan destination of one statement execution.
type scanBuf struct {
	cells []cell
	ptrs  []any
}

func (si *scanInfo) get() *scanBuf {
	if b, ok := si.bufs.Get().(*scanBuf); ok {
		return b
	}
	b := &scanBuf{cells: make([]cell, si.n), ptrs: make([]any, si.n)}
	for i := range b.cells {
		b.ptrs[i] = &b.cells[i]
	}
	return b
}

// put clears the cells so the pool keeps no row values alive.
func (si *scanInfo) put(b *scanBuf) {
	clear(b.cells)
	si.bufs.Put(b)
}

type styledScanCol struct {
	index int
	name  string
	codec []string
	host  []string
}

func newCached(key uint64, p *plan.Plan) *cached {
	c := &cached{key: key, id: PlanID(key), plan: p, scans: map[*plan.Step]*scanInfo{}}
	for i := range p.Steps {
		st := &p.Steps[i]
		if st.Assemble != nil {
			c.scans[st] = &scanInfo{n: countCols(st.Assemble), styled: styledScanCols(st.Assemble)}
		}
	}
	return c
}

func (d *DB) plan(r *request) (*cached, error) {
	if r.err != nil {
		return nil, r.err
	}
	// The plan cache key is manifestHash and the request shape, so a different text with the same hash, or this
	// is checked before the cache is read, so that a manifest not registered on the connection does not use a cached plan.
	eng, err := d.engineFor(r.schema)
	if err != nil {
		return nil, err
	}
	if !r.canonical {
		if err := canonicalize(r); err != nil {
			return nil, err
		}
	}
	key := shapeKey(&r.ir)
	d.m.planMu.RLock()
	c, ok := d.plans[key]
	d.m.planMu.RUnlock()
	if ok {
		return c, nil
	}
	p, err := d.compile(eng, &r.ir)
	if err != nil {
		return nil, err
	}
	c = newCached(key, p)
	d.m.planMu.Lock()
	defer d.m.planMu.Unlock()
	if prev, ok := d.plans[key]; ok {
		return prev, nil
	}
	d.plans[key] = c
	d.m.planOrder = append(d.m.planOrder, key)
	for len(d.m.planOrder) > d.cfg.PlanCacheSize {
		delete(d.plans, d.m.planOrder[0])
		d.m.planOrder = d.m.planOrder[1:]
	}
	return c, nil
}

// localTime reads a stored date or time value in the connection time zone. A
// value the driver returns in UTC is a wall-clock value without a zone; any
// other value is an instant.
func (d *DB) localTime(v any) any {
	switch x := v.(type) {
	case string:
		for _, layout := range []string{"2006-01-02 15:04:05.999999", "2006-01-02T15:04:05.999999Z07:00", "2006-01-02"} {
			if t, err := time.ParseInLocation(layout, x, d.location); err == nil {
				return t
			}
		}
	case time.Time:
		if x.Location() == d.location {
			return v
		}
		if x.Location() == time.UTC {
			return time.Date(x.Year(), x.Month(), x.Day(), x.Hour(), x.Minute(), x.Second(), x.Nanosecond(), d.location)
		}
		return x.In(d.location)
	}
	return v
}

// now is the executor clock as UTC wall-clock text.
func (d *DB) now() time.Time {
	if t := d.m.fixedClock.Load(); t != nil {
		return t.In(d.location)
	}
	return time.Now().In(d.location).Truncate(time.Microsecond)
}

// clockText is the datetime text of the clock truncated to precision fractional digits.
func clockText(t time.Time, precision int) string {
	layout := "2006-01-02 15:04:05"
	if precision > 0 {
		layout += "." + strings.Repeat("0", precision)
	}
	return t.Format(layout)
}

// args resolves the bind slots of a step; masks marks secret and clock
// positions for the query event.
func (d *DB) args(st *plan.Step, r *request, parentVals []any) (out []any, masks map[int]string, err error) {
	out = make([]any, 0, len(st.BindSlots))
	mask := func(v string) {
		if masks == nil {
			masks = map[int]string{}
		}
		masks[len(out)] = v
	}
	// One statement reads the clock once, so its clock columns are equal.
	var clock time.Time
	for _, b := range st.BindSlots {
		switch b.From {
		case "param":
			// A transformed value is the text of its operator, and a host-styled value is the
			// input of its first stage, which HostEncode checks.
			if b.Param < len(r.params) {
				if err := checkAssign(b.Param, r.params[b.Param], bindSlotType(&b)); err != nil {
					return nil, nil, err
				}
			}
			if b.Transform == "" && len(b.HostStyles) == 0 && b.Param < len(r.params) {
				if err := d.checkParam(b.Param, r.params[b.Param], bindSlotType(&b)); err != nil {
					return nil, nil, err
				}
			}
			v, err := paramValue(&b, r)
			if err != nil {
				return nil, nil, err
			}
			if len(b.HostStyles) > 0 {
				if slices.Contains(b.HostStyles, "blind_index") {
					if v != nil {
						if v, err = BlindIndex(v, d.cfg.BlindIndexKey); err != nil {
							return nil, nil, err
						}
					}
				} else if v, err = HostEncode(v, b.HostStyles, d.cfg.AESKey); err != nil {
					return nil, nil, err
				}
			}
			if (b.ColType == "datetime" || b.ColType == "date" || b.ColType == "time") && v != nil {
				if v, err = d.bindTimeValue(v, b.ColType, b.Precision); err != nil {
					return nil, nil, err
				}
			}
			if b.ColType == "decimal" && v != nil {
				value, ok := v.(string)
				if !ok {
					return nil, nil, codecErr(CodeCodecEncode, "decimal bind is %T, expected string", v)
				}
				if d.driver == "sqlite" {
					v, err = DecimalScaledInt(value, b.Precision, b.Scale)
				} else {
					v, err = NormalizeDecimal(value, b.Precision, b.Scale)
				}
				if err != nil {
					return nil, nil, err
				}
			}
			out = append(out, v)
		case "secret":
			if b.Name != "aes" || d.cfg.AESKey == "" {
				return nil, nil, configErr("secret %q is not configured", b.Name)
			}
			mask(Secret)
			out = append(out, d.cfg.AESKey)
		case "config":
			if b.Name != "aes_version" {
				return nil, nil, configErr("config value %q is not configured", b.Name)
			}
			out = append(out, d.cfg.AESVersion)
		case "parent":
			out = append(out, parentVals...)
		case "now":
			mask(NowBind)
			if clock.IsZero() {
				clock = d.now()
			}
			out = append(out, clockText(clock, b.Precision))
		case "audit":
			v, err := auditValue(r.audit, b.Name)
			if err != nil {
				return nil, nil, err
			}
			out = append(out, v)
		default:
			return nil, nil, &ir.Error{Code: CodeInternal, Msg: "bind from " + b.From}
		}
	}
	// A datetime column is a wall clock with no time zone, so a value with an offset is converted to UTC
	// and sent as wall clock text. A PostgreSQL timestamp drops the offset
	// (postgres.timestamp.ignores_offset).
	for i, v := range out {
		if t, ok := v.(time.Time); ok {
			out[i] = t.In(d.location).Format("2006-01-02 15:04:05.000000")
		}
	}
	return out, masks, nil
}

// auditValue is the value of the audit slot: the primary
// key of the audit record the transaction inserted. Without an audit, or if the audit table records into another table, it is CONFIG.
// bindsAudit is whether the statement binds the audit record's key: it writes an audited table.
func bindsAudit(st *plan.Step) bool {
	return slices.ContainsFunc(st.BindSlots, func(b plan.BindSlot) bool { return b.From == "audit" })
}

func auditValue(a *auditRecord, record string) (any, error) {
	if a == nil {
		return nil, configErr("a write of an audited table needs an audit: run it in a transaction with orm.Audit(record)")
	}
	if a.table != record {
		return nil, configErr("the audited table records its audits in %s, but the audit of the transaction is a row of %s", record, a.table)
	}
	return a.key, nil
}

func paramValue(b *plan.BindSlot, r *request) (any, error) {
	v := r.params[b.Param]
	if b.Transform == "" {
		return v, nil
	}
	return transformParam(b.Transform, v)
}

// transformParam applies the value transform kind to a parameter: SQL NULL binds NULL, so
// `col LIKE NULL` matches no row, and a value other than text is CODEC_ENCODE.
func transformParam(kind string, v any) (any, error) {
	if v == nil {
		return nil, nil
	}
	s, ok := v.(string)
	if !ok {
		return nil, codecErr(CodeCodecEncode, "%s requires a string value", kind)
	}
	return Transform(kind, s), nil
}

// Transform applies an executor-side value transform.
func Transform(kind, s string) string {
	switch kind {
	case "like_contains":
		return "%" + strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s) + "%"
	}
	return s
}

// Statement is the text and binds of a statement that was not executed.
type Statement struct {
	SQL   string
	Binds []any
}

func getQuery(ex executor, r *request) (*Statement, error) {
	d := ex.base()
	if err := d.unsupportedOnMarkdown("getQuery"); err != nil {
		return nil, err
	}
	if err := applyRequestHook(ex, r); err != nil {
		return nil, err
	}
	c, err := d.plan(r)
	if err != nil {
		return nil, err
	}
	st := &c.plan.Steps[0]
	args, masks, err := d.args(st, r, nil)
	if err != nil {
		return nil, err
	}
	for i, m := range masks {
		args[i] = m
	}
	return &Statement{SQL: st.SQL, Binds: args}, nil
}

// Execute runs one compiled statement st, a step of a plan of the engine
// (engine.Engine.Compile, planner.Planner.Compile), with the request
// parameters params, on the connection or on its active transaction. Its bind
// slots are resolved as a model statement's are: host styles, decimals,
// SQLite time values, the AES key and key version, the clock and the audit of
// the transaction. A step that reads rows (it has an assemble) and a param slot
// past params fail with IR_INVALID before any statement runs (docs/operations/usage.md
// "Execute a compiled statement").
func (d *DB) Execute(st *plan.Step, params []any) error {
	ex, err := resolve(d)
	if err != nil {
		return err
	}
	done, err := ex.enter()
	if err != nil {
		return err
	}
	defer done()
	if st.Assemble != nil {
		return &ir.Error{Code: CodeIrInvalid, Msg: "execute runs a statement without rows; the statement is a read"}
	}
	for i, b := range st.BindSlots {
		if b.From == "param" && (b.Param < 0 || b.Param >= len(params)) {
			return &ir.Error{Code: CodeIrInvalid, Msg: fmt.Sprintf("bind slot %d reads parameter %d, but execute has %d parameters", i, b.Param, len(params))}
		}
	}
	r := &request{params: params}
	if t := ex.transaction(); t != nil {
		if bindsAudit(st) {
			if _, err := t.auditFor(false); err != nil {
				return err
			}
		}
		r.audit = t.audit
	}
	args, masks, err := d.args(st, r, nil)
	if err != nil {
		return err
	}
	ctx := ex.context()
	stmt, err := ex.stmt(ctx, st.SQL)
	if err != nil {
		return err
	}
	start := time.Now()
	if err := d.takeStatementFault(); err != nil {
		return d.modelDone(ex, st, st.SQL, args, masks, start, err)
	}
	_, err = stmt.ExecContext(ctx, args...)
	return d.modelDone(ex, st, st.SQL, args, masks, start, mapDriverErr(err))
}

// modelDone publishes the event of a model statement and returns the error
// the operation receives. bind is the value with secret and time slots masked.
func (d *DB) modelDone(ex executor, st *plan.Step, sqlText string, args []any, masks map[int]string, start time.Time, err error) error {
	shown := args
	if len(masks) > 0 {
		shown = slices.Clone(args)
		for i, m := range masks {
			shown[i] = m
		}
	}
	return d.statementDone(statementKind(st.SQL), st.Tables, transactionNumber(ex), sqlText, shown, start, err)
}

// transactionNumber is ex's transaction number if ex is a transaction, otherwise 0.
func transactionNumber(ex executor) int64 {
	if t := ex.transaction(); t != nil {
		return t.number
	}
	return 0
}

// result is the positional result of a select plan.
type result struct {
	cache  *cached
	plan   *plan.Plan
	main   [][]any
	steps  map[int]*stepRows
	params []any
	// markdown means the result is a markdown answer: the last cell of each row holds that row's join and
	// relation rows (mdLinks).
	markdown bool
}

type stepRows struct {
	step  *plan.Step
	data  [][]any
	byKey map[Key][]int
}

// related returns the rows of relation ch for one parent row.
func (res *result) related(ch *plan.Child, parent []any) ([][]any, error) {
	sr := res.steps[ch.Step]
	if sr == nil {
		return nil, nil
	}
	if ifp := sr.step.Parent.IfParent; ifp != nil {
		match, err := ifParentMatch(parent[ifp.Index], res.params[ifp.Param])
		if err != nil {
			return nil, err
		}
		if !match {
			return nil, nil
		}
	}
	key, ok, err := keyFromRow(parent, ch.ParentKeys)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, nil
	}
	idxs := sr.byKey[key]
	out := make([][]any, len(idxs))
	for i, j := range idxs {
		out[i] = sr.data[j]
	}
	return out, nil
}

// applyRequestHook applies the request hook of the handle that ex passes through to r just before planning (docs/operations/usage.md
// "Request hook"). The hook changes r.ir in place and adds parameters with r.param. Since r is a new request for each terminal call,
// it is not shared with other calls. A handle without a hook does nothing, and the hook's
// error is returned as is; a request whose builder already failed returns the builder's error first. The changed request
// is validated by d.plan like any other request.
func applyRequestHook(ex executor, r *request) error {
	// The error of the builder comes before the hook and before any later check of the statement.
	if r.err != nil {
		return r.err
	}
	hook := ex.requestHook()
	if hook == nil {
		return nil
	}
	if err := hook(&r.ir, r.param, slices.Clone(r.params)); err != nil {
		return err
	}
	r.ir.NParams = len(r.params)
	return nil
}

func checkLock(ex executor, r *request) error {
	if r.ir.Lock != "" && ex.transaction() == nil {
		return configErr("row locks are allowed only inside a transaction")
	}
	return nil
}

// beginRead enters the executor for a read of r and checks the request with
// the request hook and the lock rules. It returns the function that leaves the
// executor, the base handle and its context; on an error it has already left
// the executor.
func beginRead(ex executor, r *request) (func(), *DB, context.Context, error) {
	done, err := ex.enter()
	if err != nil {
		return nil, nil, nil, err
	}
	if err := applyRequestHook(ex, r); err != nil {
		done()
		return nil, nil, nil, err
	}
	if err := checkLock(ex, r); err != nil {
		done()
		return nil, nil, nil, err
	}
	return done, ex.base(), ex.context(), nil
}

// query runs the main select step and every relation step.
func query(ex executor, r *request) (*result, error) {
	done, d, ctx, err := beginRead(ex, r)
	if err != nil {
		return nil, err
	}
	defer done()
	if d.md != nil {
		res, _, err := markdownRead(ex, r)
		return res, err
	}
	c, err := d.plan(r)
	if err != nil {
		return nil, err
	}
	if err := acquireSQLiteRowLock(ctx, ex, r.ir.Lock); err != nil {
		return nil, err
	}
	parts, err := rootINParts(r, &c.plan.Steps[0], d.driver)
	if err != nil {
		return nil, err
	}
	var main [][]any
	if len(parts) > 1 {
		seen := map[Key]bool{}
		for _, part := range parts {
			pc, err := d.plan(part)
			if err != nil {
				return nil, err
			}
			rows, err := runSelect(ctx, ex, pc, &pc.plan.Steps[0], part, nil)
			if err != nil {
				return nil, err
			}
			for _, row := range rows {
				key, present, err := keyFromRow(row, pc.plan.Steps[0].Assemble.Key)
				if err != nil {
					return nil, err
				}
				if !present {
					return nil, codecErr(CodeCodecDecode, "split query row identity contains SQL NULL")
				}
				if !seen[key] {
					seen[key] = true
					main = append(main, row)
				}
			}
		}
	} else if main, err = runSelect(ctx, ex, c, &c.plan.Steps[0], r, nil); err != nil {
		return nil, err
	}
	return runRelations(ctx, ex, c, r, main)
}

func runRelations(ctx context.Context, ex executor, c *cached, r *request, main [][]any) (*result, error) {
	d := ex.base()
	p := c.plan
	out := &result{cache: c, plan: p, main: main, params: r.params}
	for i := range p.Steps[1:] {
		st := &p.Steps[i+1]
		if st.Role != "relation" {
			continue
		}
		parents := out.main
		if st.Parent.Step != 0 {
			parents = out.steps[st.Parent.Step].data
		}
		sr := &stepRows{step: st, byKey: map[Key][]int{}}
		vals, err := parentValues(st.Parent, parents, r.params)
		if err != nil {
			return nil, err
		}
		if len(vals) > 0 {
			chunks, err := relationChunks(st, vals, d.driver)
			if err != nil {
				return nil, err
			}
			for _, chunk := range chunks {
				part, err := runSelect(ctx, ex, c, st, r, chunk)
				if err != nil {
					return nil, err
				}
				sr.data = append(sr.data, part...)
			}
			keys := childKeys(p, st)
			for j, row := range sr.data {
				key, ok, err := keyFromRow(row, keys)
				if err != nil {
					return nil, err
				}
				if ok {
					sr.byKey[key] = append(sr.byKey[key], j)
				}
			}
		}
		if out.steps == nil {
			out.steps = map[int]*stepRows{}
		}
		out.steps[st.ID] = sr
	}
	return out, nil
}

// relationChunks bounds one relation statement by the driver bind limit.
func relationChunks(st *plan.Step, vals []any, driver string) ([][]any, error) {
	width := len(st.Parent.Keys)
	if width == 0 || len(vals)%width != 0 {
		return nil, &ir.Error{Code: CodeInternal, Msg: fmt.Sprintf("relation %d has invalid parent key values", st.ID)}
	}
	nonParent := 0
	for _, bind := range st.BindSlots {
		if bind.From != "parent" {
			nonParent++
		}
	}
	maxTuples := (driverBindLimit(driver) - nonParent) / width
	if maxTuples < 1 {
		return nil, &ir.Error{Code: CodeIrInvalid, Msg: fmt.Sprintf("relation %d needs more bind parameters than %s permits", st.ID, driver)}
	}
	chunk := 1
	for chunk*2 <= maxTuples {
		chunk *= 2
	}
	tuples := len(vals) / width
	var out [][]any
	for start := 0; start < tuples; start += chunk {
		end := min(start+chunk, tuples)
		out = append(out, slices.Clone(vals[start*width:end*width]))
	}
	return out, nil
}

func childKeys(p *plan.Plan, st *plan.Step) []plan.KeyRef {
	var find func(a *plan.Assemble) []plan.KeyRef
	find = func(a *plan.Assemble) []plan.KeyRef {
		for _, ch := range a.Children {
			if ch.Kind != "join" && ch.Step == st.ID {
				return ch.ChildKeys
			}
			if ch.Kind == "join" {
				if keys := find(ch.Assemble); len(keys) > 0 {
					return keys
				}
			}
		}
		return nil
	}
	for i := range p.Steps {
		if p.Steps[i].Assemble != nil {
			if keys := find(p.Steps[i].Assemble); len(keys) > 0 {
				return keys
			}
		}
	}
	panic("orm: relation step without a child")
}

// ifParentMatch reports whether a parent cell equals the if_parent parameter. The parameter has the
// column's logical type; a bool column is the integer 0 or 1 on MySQL and SQLite, so a bool parameter
// compares with the cell read as a bool.
func ifParentMatch(cell, param any) (bool, error) {
	if want, ok := param.(bool); ok && cell != nil {
		got, err := AsBool(cell)
		if err != nil {
			return false, err
		}
		return got == want, nil
	}
	return SameScalar(cell, param)
}

func parentValues(pr *plan.ParentRef, parents [][]any, params []any) ([]any, error) {
	seen := map[Key]bool{}
	var out []any
	for _, row := range parents {
		if pr.IfParent != nil {
			match, err := ifParentMatch(row[pr.IfParent.Index], params[pr.IfParent.Param])
			if err != nil {
				return nil, err
			}
			if !match {
				continue
			}
		}
		key, ok, err := keyFromRow(row, pr.Keys)
		if err != nil {
			return nil, err
		}
		if !ok || seen[key] {
			continue
		}
		seen[key] = true
		for _, ref := range pr.Keys {
			out = append(out, row[ref.Index])
		}
	}
	return out, nil
}

// expandIn rewrites the single parent placeholder into a padded list.
func expandIn(st *plan.Step, vals []any) (string, []any, error) {
	width := len(st.Parent.Keys)
	tuples := len(vals) / width
	n := 1
	for n < tuples {
		n <<= 1
	}
	padded := make([]any, n*width)
	copy(padded, vals)
	for i := tuples; i < n; i++ {
		copy(padded[i*width:(i+1)*width], vals[(tuples-1)*width:tuples*width])
	}
	list := func(sb *strings.Builder, ph func(m int) string) {
		for m := 0; m < n*width; m++ {
			if m > 0 {
				if width > 1 && m%width == 0 {
					sb.WriteString("), (")
				} else {
					sb.WriteString(", ")
				}
			}
			sb.WriteString(ph(m))
		}
	}
	var sb strings.Builder
	if strings.Contains(st.SQL, "$1") {
		parent := -1
		for i, b := range st.BindSlots {
			if b.From == "parent" {
				parent = i + 1
			}
		}
		for i := 0; i < len(st.SQL); i++ {
			if st.SQL[i] != '$' {
				sb.WriteByte(st.SQL[i])
				continue
			}
			j := i + 1
			for j < len(st.SQL) && st.SQL[j] >= '0' && st.SQL[j] <= '9' {
				j++
			}
			if j == i+1 {
				// A '$' that does not start a numbered placeholder is written as it is.
				sb.WriteByte('$')
				continue
			}
			k, err := strconv.Atoi(st.SQL[i+1 : j])
			if err != nil {
				return "", nil, &ir.Error{Code: CodeInternal, Msg: fmt.Sprintf("placeholder %q of the statement is not a number", st.SQL[i:j]), Cause: err}
			}
			switch {
			case k == parent:
				list(&sb, func(m int) string { return "$" + strconv.Itoa(k+m) })
			case k > parent:
				sb.WriteString("$" + strconv.Itoa(k+n*width-1))
			default:
				sb.WriteString("$" + strconv.Itoa(k))
			}
			i = j - 1
		}
		return sb.String(), padded, nil
	}
	slot := 0
	for i := 0; i < len(st.SQL); i++ {
		if st.SQL[i] != '?' {
			sb.WriteByte(st.SQL[i])
			continue
		}
		if st.BindSlots[slot].From == "parent" {
			list(&sb, func(int) string { return "?" })
		} else {
			sb.WriteByte('?')
		}
		slot++
	}
	return sb.String(), padded, nil
}

const rowChunk = 32

// cell receives one column; driver byte slices are copied once into a string.
type cell struct{ v any }

func (c *cell) Scan(src any) error {
	if b, ok := src.([]byte); ok {
		c.v = string(b)
		return nil
	}
	c.v = src
	return nil
}

func runSelect(ctx context.Context, ex executor, c *cached, st *plan.Step, r *request, parentVals []any) ([][]any, error) {
	d := ex.base()
	sqlText := st.SQL
	if parentVals != nil {
		var err error
		sqlText, parentVals, err = expandIn(st, parentVals)
		if err != nil {
			return nil, err
		}
	}
	args, masks, err := d.args(st, r, parentVals)
	if err != nil {
		return nil, err
	}
	stmt, err := ex.stmt(ctx, sqlText)
	if err != nil {
		return nil, err
	}
	start := time.Now()
	if err := d.takeStatementFault(); err != nil {
		return nil, d.modelDone(ex, st, sqlText, args, masks, start, err)
	}
	rows, err := stmt.QueryContext(ctx, args...)
	err = mapDriverErr(err)
	if err != nil {
		return nil, d.modelDone(ex, st, sqlText, args, masks, start, err)
	}
	si := c.scans[st]
	buf := si.get()
	defer si.put(buf)
	cells, ptrs := buf.cells, buf.ptrs
	var keyring AESKeyring
	if assembleHasAES(st.Assemble) {
		if keyring, err = d.aesKeyring(); err != nil {
			return nil, closeAfter(rows, err)
		}
	}
	var out [][]any
	var chunk []any
	// decodeErr is a client-side error for failing to decode a read row. It is not a statement error, so
	// it is not included in the event.
	var decodeErr error
	for rows.Next() {
		if err = rows.Scan(ptrs...); err != nil {
			err = mapDriverErr(err)
			break
		}
		// The first row gets its own slice; later rows share chunks of
		// rowChunk rows. Each row is capped to its width.
		if len(chunk) < si.n {
			n := rowChunk
			if out == nil {
				n = 1
			}
			chunk = make([]any, si.n*n)
		}
		vals := chunk[:si.n:si.n]
		chunk = chunk[si.n:]
		for i := range cells {
			vals[i] = cells[i].v
		}
		if decodeErr = decodeSelectedRow(vals, si, st, keyring); decodeErr != nil {
			break
		}
		out = append(out, vals)
	}
	if err == nil {
		err = mapDriverErr(rows.Err())
	}
	if closeErr := rows.Close(); err == nil {
		err = mapDriverErr(closeErr)
	}
	if err := d.modelDone(ex, st, sqlText, args, masks, start, err); err != nil {
		return nil, err
	}
	if decodeErr != nil {
		return nil, decodeErr
	}
	return out, nil
}

func decodeSelectedRow(vals []any, si *scanInfo, st *plan.Step, keyring AESKeyring) error {
	version := int32(1)
	if at := st.Assemble.AESVersion; at != nil {
		col := st.Assemble.Columns[*at]
		var err error
		if version, err = rowVersion(vals[col.Index]); err != nil {
			return fmt.Errorf("%s.%s: %w", st.Assemble.Entity, col.Name, err)
		}
	}
	for _, sc := range si.styled {
		v := vals[sc.index]
		if v == nil {
			if len(sc.codec) > 0 {
				vals[sc.index] = SqlNull()
			}
			continue
		}
		var err error
		// A host stage without aes (hex, ip) is decoded without a key.
		switch {
		case slices.Contains(sc.host, "aes"):
			v, err = HostDecodeVersioned(v, sc.host, version, keyring)
		case len(sc.host) > 0:
			v, err = HostDecode(v, sc.host, "")
		}
		if err != nil {
			return fmt.Errorf("%s.%s: %w", st.Assemble.Entity, sc.name, err)
		}
		if len(sc.codec) > 0 {
			if v, err = Decode(sc.codec, v); err != nil {
				return fmt.Errorf("%s.%s: %w", st.Assemble.Entity, sc.name, err)
			}
		}
		vals[sc.index] = v
	}
	return restoreByteColumns(vals, st.Assemble)
}

func restoreByteColumns(vals []any, asm *plan.Assemble) error {
	for _, col := range asm.Columns {
		if col.Type != "bytes" || len(col.Styles) != 0 {
			continue
		}
		if col.Index < 0 || col.Index >= len(vals) {
			return codecErr(CodeInternal, "byte column %q index %d is out of bounds", col.Name, col.Index)
		}
		if vals[col.Index] == nil {
			continue
		}
		switch value := vals[col.Index].(type) {
		case string:
			vals[col.Index] = []byte(value)
		case []byte:
			// The column is already represented as bytes.
		default:
			return codecErr(CodeCodecDecode, "byte column %q has invalid value %T", col.Name, value)
		}
	}
	for _, child := range asm.Children {
		if child.Kind == "join" && child.Assemble != nil {
			if err := restoreByteColumns(vals, child.Assemble); err != nil {
				return err
			}
		}
	}
	return nil
}

func styledScanCols(a *plan.Assemble) []styledScanCol {
	var out []styledScanCol
	for _, c := range a.Columns {
		if len(c.Styles) == 0 {
			continue
		}
		codec, host := splitHost(c.Styles)
		out = append(out, styledScanCol{index: c.Index, name: c.Name, codec: codec, host: host})
	}
	for _, ch := range a.Children {
		if ch.Kind == "join" {
			out = append(out, styledScanCols(ch.Assemble)...)
		}
	}
	return out
}

func assembleHasAES(asm *plan.Assemble) bool {
	if asm == nil {
		return false
	}
	for _, col := range asm.Columns {
		if slices.Contains(col.Styles, "aes") {
			return true
		}
	}
	for _, child := range asm.Children {
		if assembleHasAES(child.Assemble) {
			return true
		}
	}
	return false
}

func countCols(a *plan.Assemble) int {
	n := len(a.Columns)
	for _, c := range a.Children {
		if c.Kind == "join" {
			n += countCols(c.Assemble)
		}
	}
	return n
}

// scalar runs a count, sum, or avg statement; nil means SQL NULL.
func scalar(ex executor, r *request) (any, error) {
	done, d, ctx, err := beginRead(ex, r)
	if err != nil {
		return nil, err
	}
	defer done()
	if d.md != nil {
		return markdownScalar(ex, r)
	}
	c, err := d.plan(r)
	if err != nil {
		return nil, err
	}
	parts, err := rootINParts(r, &c.plan.Steps[0], d.driver)
	if err != nil {
		return nil, err
	}
	if len(parts) > 1 {
		if r.ir.Kind != "count" {
			return nil, &ir.Error{Code: CodeIrInvalid, Msg: "a split IN list can be merged only for a count"}
		}
		var total int64
		for _, part := range parts {
			v, err := scalarStep(ctx, ex, part)
			if err != nil {
				return nil, err
			}
			n, err := AsInt64(v)
			if err != nil {
				return nil, err
			}
			if (n > 0 && total > math.MaxInt64-n) || (n < 0 && total < math.MinInt64-n) {
				return nil, codecErr(CodeCodecDecode, "split count overflows int64")
			}
			total += n
		}
		return total, nil
	}
	return scalarStep(ctx, ex, r)
}

func scalarStep(ctx context.Context, ex executor, r *request) (any, error) {
	d := ex.base()
	c, err := d.plan(r)
	if err != nil {
		return nil, err
	}
	st := &c.plan.Steps[0]
	return scanOne(ctx, ex, c, st, r)
}

func scanOne(ctx context.Context, ex executor, c *cached, st *plan.Step, r *request) (any, error) {
	d := ex.base()
	args, masks, err := d.args(st, r, nil)
	if err != nil {
		return nil, err
	}
	stmt, err := ex.stmt(ctx, st.SQL)
	if err != nil {
		return nil, err
	}
	var v cell
	start := time.Now()
	if err := d.takeStatementFault(); err != nil {
		return nil, d.modelDone(ex, st, st.SQL, args, masks, start, err)
	}
	err = mapDriverErr(stmt.QueryRowContext(ctx, args...).Scan(&v))
	if err := d.modelDone(ex, st, st.SQL, args, masks, start, err); err != nil {
		return nil, err
	}
	return v.v, nil
}

// paginate runs the page statement with its relations and the count statement.
func paginate(ex executor, r *request) (*result, int64, error) {
	done, err := ex.enter()
	if err != nil {
		return nil, 0, err
	}
	defer done()
	if err := applyRequestHook(ex, r); err != nil {
		return nil, 0, err
	}
	if err := checkLock(ex, r); err != nil {
		return nil, 0, err
	}
	d, ctx := ex.base(), ex.context()
	if d.md != nil {
		return markdownRead(ex, r)
	}
	c, err := d.plan(r)
	if err != nil {
		return nil, 0, err
	}
	main, err := runSelect(ctx, ex, c, &c.plan.Steps[0], r, nil)
	if err != nil {
		return nil, 0, err
	}
	res, err := runRelations(ctx, ex, c, r, main)
	if err != nil {
		return nil, 0, err
	}
	for i := range c.plan.Steps {
		if st := &c.plan.Steps[i]; st.Role == "count" {
			v, err := scanOne(ctx, ex, c, st, r)
			if err != nil {
				return nil, 0, err
			}
			n, err := AsInt64(v)
			return res, n, err
		}
	}
	return nil, 0, &ir.Error{Code: CodeInternal, Msg: "paginate plan has no count step"}
}

// write runs an insert, update, delete, or restore and returns the key of the
// inserted row and the affected row count: the generated identity on a SQL
// database, the first key the markdown executor answers.
func write(ex executor, r *request) (key any, affected int64, err error) {
	return writeAfterHook(ex, r, nil)
}

// writeAfterHook is write. When after is not nil it reads the request as the hook left it, before the planner
// renumbers the parameters (canonicalize), so a key read there keeps the numbers the model gave its own values.
func writeAfterHook(ex executor, r *request, after func(*request) error) (key any, affected int64, err error) {
	done, err := ex.enter()
	if err != nil {
		return nil, 0, err
	}
	defer done()
	defer func() {
		if err == nil {
			ex.base().m.lastAffected.Store(affected + 1)
		}
	}()
	if err := applyRequestHook(ex, r); err != nil {
		return nil, 0, err
	}
	if after != nil {
		if err := after(r); err != nil {
			return nil, 0, err
		}
	}
	d, ctx := ex.base(), ex.context()
	if d.md != nil {
		keys, affected, err := markdownWrite(ex, r)
		if err != nil || len(keys) == 0 {
			return nil, affected, err
		}
		return keys[0], affected, nil
	}
	var lastID int64
	c, err := d.plan(r)
	if err != nil {
		return nil, 0, err
	}
	st := &c.plan.Steps[0]
	settle := func(int64, error) error { return nil }
	if t := ex.transaction(); t != nil {
		if bindsAudit(st) {
			if settle, err = t.auditFor(r.ir.Kind != "insert"); err != nil {
				return nil, 0, err
			}
		}
		r.audit = t.audit
	}
	defer func() {
		if settleErr := settle(affected, err); settleErr != nil && err == nil {
			key, affected, err = nil, 0, settleErr
		}
	}()
	args, masks, err := d.args(st, r, nil)
	if err != nil {
		return nil, 0, err
	}
	stmt, err := ex.stmt(ctx, st.SQL)
	if err != nil {
		return nil, 0, err
	}
	start := time.Now()
	if err := d.takeStatementFault(); err != nil {
		return nil, 0, d.modelDone(ex, st, st.SQL, args, masks, start, err)
	}
	if r.ir.Kind == "insert" && strings.Contains(st.SQL, " RETURNING ") {
		err = mapDriverErr(stmt.QueryRowContext(ctx, args...).Scan(&lastID))
		if err := d.modelDone(ex, st, st.SQL, args, masks, start, err); err != nil {
			return nil, 0, err
		}
		return lastID, 1, nil
	}
	res, err := stmt.ExecContext(ctx, args...)
	err = mapDriverErr(err)
	if err := d.modelDone(ex, st, st.SQL, args, masks, start, err); err != nil {
		return nil, 0, err
	}
	affected, err = res.RowsAffected()
	if err != nil {
		return nil, 0, mapDriverErr(err)
	}
	if r.ir.Kind == "insert" && len(r.ir.OnDuplicate) > 0 {
		// An upsert writes one row: MySQL counts 2 for the one that updates, PostgreSQL and SQLite 1.
		affected = 1
	}
	if r.ir.Kind == "insert" && len(r.ir.Rows) == 0 {
		lastID, err = res.LastInsertId()
		if err != nil {
			return nil, 0, mapDriverErr(err)
		}
	}
	if r.ir.Kind == "update" && r.ir.Optimistic != nil && affected == 0 {
		return nil, 0, &ir.Error{Code: CodeOptimisticLock, Msg: "the row changed after it was read"}
	}
	return lastID, affected, nil
}
