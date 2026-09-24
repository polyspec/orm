package orm

import (
	"context"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/polyspec/orm/engine/ir"
	"github.com/polyspec/orm/engine/plan"
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
	r.ir.NParams = len(r.params)
	key := shapeKey(&r.ir)
	d.m.planMu.RLock()
	c, ok := d.plans[key]
	d.m.planMu.RUnlock()
	if ok {
		return c, nil
	}
	p, err := d.compile(&r.ir)
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

// now is the executor clock in the connection time zone. PostgreSQL receives
// the offset because its columns store instants.
func (d *DB) now() string {
	if d.driver == "postgres" {
		return time.Now().In(d.location).Format("2006-01-02 15:04:05.000000-07:00")
	}
	return time.Now().In(d.location).Format("2006-01-02 15:04:05.000000")
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
	clock := ""
	for _, b := range st.BindSlots {
		switch b.From {
		case "param":
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
			if d.driver == "sqlite" && (b.ColType == "datetime" || b.ColType == "date") && v != nil {
				if v, err = d.sqliteTimeValue(v, b.ColType); err != nil {
					return nil, nil, err
				}
			}
			if b.ColType == "point" && v != nil {
				p, err := ParsePoint(v)
				if err != nil {
					return nil, nil, err
				}
				if d.driver == "postgres" {
					v, err = postgresPointText(p)
				} else {
					v, err = PointText(p)
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
			if clock == "" {
				clock = d.now()
			}
			out = append(out, clock)
		default:
			return nil, nil, &ir.Error{Code: CodeInternal, Msg: "bind from " + b.From}
		}
	}
	if d.driver != "postgres" {
		for i, v := range out {
			if t, ok := v.(time.Time); ok {
				out[i] = t.In(d.location).Format("2006-01-02 15:04:05.000000")
			}
		}
	}
	return out, masks, nil
}

func paramValue(b *plan.BindSlot, r *request) (any, error) {
	v := r.params[b.Param]
	if b.Transform == "" {
		return v, nil
	}
	s, ok := v.(string)
	if !ok {
		return nil, configErr("%s requires a string value", b.Transform)
	}
	return Transform(b.Transform, s), nil
}

// Transform applies an executor-side value transform.
func Transform(kind, s string) string {
	switch kind {
	case "fulltext_boolean":
		s = strings.TrimSpace(s)
		if s == "" {
			return s
		}
		return "+" + strings.ReplaceAll(s, " ", " +") + "*"
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

func (d *DB) statement(ctx context.Context, r *request) (*Statement, error) {
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

func (d *DB) emit(c *cached, sqlText string, args []any, masks map[int]string, start time.Time, err error) {
	if d.cfg.OnQuery == nil {
		return
	}
	if len(masks) > 0 {
		args = slices.Clone(args)
		for i, m := range masks {
			args[i] = m
		}
	}
	d.cfg.OnQuery(Event{SQL: sqlText, Args: args, Duration: time.Since(start), PlanID: c.id, Err: err})
}

// result is the positional result of a select plan.
type result struct {
	cache  *cached
	plan   *plan.Plan
	main   [][]any
	steps  map[int]*stepRows
	params []any
}

type stepRows struct {
	step  *plan.Step
	data  [][]any
	byKey map[Key][]int
}

// related returns the rows of relation ch for one parent row.
func (res *result) related(ch *plan.Child, parent []any) [][]any {
	sr := res.steps[ch.Step]
	if sr == nil {
		return nil
	}
	if ifp := sr.step.Parent.IfParent; ifp != nil && !SameScalar(parent[ifp.Index], res.params[ifp.Param]) {
		return nil
	}
	key, ok := keyFromRow(parent, ch.ParentKeys)
	if !ok {
		return nil
	}
	idxs := sr.byKey[key]
	out := make([][]any, len(idxs))
	for i, j := range idxs {
		out[i] = sr.data[j]
	}
	return out
}

func checkLock(ex executor, r *request) error {
	if r.ir.Query.Lock != "" && ex.transaction() == nil {
		return configErr("row locks are allowed only inside a transaction")
	}
	return nil
}

// query runs the main select step and every relation step.
func query(ex executor, r *request) (*result, error) {
	done, err := ex.enter()
	if err != nil {
		return nil, err
	}
	defer done()
	if err := checkLock(ex, r); err != nil {
		return nil, err
	}
	d, ctx := ex.base(), ex.context()
	c, err := d.plan(r)
	if err != nil {
		return nil, err
	}
	if err := acquireSQLiteRowLock(ctx, ex, r.ir.Query.Lock); err != nil {
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
				key, _ := keyFromRow(row, pc.plan.Steps[0].Assemble.Key)
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
		vals := parentValues(st.Parent, parents, r.params)
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
				if key, ok := keyFromRow(row, keys); ok {
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

func parentValues(pr *plan.ParentRef, parents [][]any, params []any) []any {
	seen := map[Key]bool{}
	var out []any
	for _, row := range parents {
		if pr.IfParent != nil && !SameScalar(row[pr.IfParent.Index], params[pr.IfParent.Param]) {
			continue
		}
		key, ok := keyFromRow(row, pr.Keys)
		if !ok || seen[key] {
			continue
		}
		seen[key] = true
		for _, ref := range pr.Keys {
			out = append(out, row[ref.Index])
		}
	}
	return out
}

// expandIn rewrites the single parent placeholder into a padded list.
func expandIn(st *plan.Step, vals []any) (string, []any) {
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
			k, _ := strconv.Atoi(st.SQL[i+1 : j])
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
		return sb.String(), padded
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
	return sb.String(), padded
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
		sqlText, parentVals = expandIn(st, parentVals)
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
	rows, err := stmt.QueryContext(ctx, args...)
	err = mapDriverErr(err)
	if err != nil {
		d.emit(c, sqlText, args, masks, start, err)
		return nil, err
	}
	defer rows.Close()
	si := c.scans[st]
	buf := si.get()
	defer si.put(buf)
	cells, ptrs := buf.cells, buf.ptrs
	var keyring AESKeyring
	if assembleHasAES(st.Assemble) {
		if keyring, err = d.aesKeyring(); err != nil {
			return nil, err
		}
	}
	var out [][]any
	var chunk []any
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
		if err = decodeSelectedRow(vals, si, st, keyring); err != nil {
			break
		}
		out = append(out, vals)
	}
	if err == nil {
		err = mapDriverErr(rows.Err())
	}
	d.emit(c, sqlText, args, masks, start, err)
	return out, err
}

func decodeSelectedRow(vals []any, si *scanInfo, st *plan.Step, keyring AESKeyring) error {
	version := int32(1)
	for _, col := range st.Assemble.Columns {
		if col.Hidden && col.Column == "aes_key_version" {
			var err error
			if version, err = rowVersion(vals[col.Index]); err != nil {
				return fmt.Errorf("%s.%s: %w", st.Assemble.Entity, col.Name, err)
			}
			break
		}
	}
	for _, sc := range si.styled {
		v := vals[sc.index]
		if v == nil {
			continue
		}
		var err error
		if len(sc.host) > 0 {
			if v, err = HostDecodeVersioned(v, sc.host, version, keyring); err != nil {
				return fmt.Errorf("%s.%s: %w", st.Assemble.Entity, sc.name, err)
			}
		}
		if len(sc.codec) > 0 {
			if v, err = Decode(sc.codec, v); err != nil {
				return fmt.Errorf("%s.%s: %w", st.Assemble.Entity, sc.name, err)
			}
		}
		vals[sc.index] = v
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
	done, err := ex.enter()
	if err != nil {
		return nil, err
	}
	defer done()
	if err := checkLock(ex, r); err != nil {
		return nil, err
	}
	d, ctx := ex.base(), ex.context()
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
			total += AsInt64(v)
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
	err = mapDriverErr(stmt.QueryRowContext(ctx, args...).Scan(&v))
	d.emit(c, st.SQL, args, masks, start, err)
	return v.v, err
}

// paginate runs the page statement with its relations and the count statement.
func paginate(ex executor, r *request) (*result, int64, error) {
	done, err := ex.enter()
	if err != nil {
		return nil, 0, err
	}
	defer done()
	if err := checkLock(ex, r); err != nil {
		return nil, 0, err
	}
	d, ctx := ex.base(), ex.context()
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
			return res, AsInt64(v), err
		}
	}
	return nil, 0, &ir.Error{Code: CodeInternal, Msg: "paginate plan has no count step"}
}

// write runs an insert, update, or delete and returns the generated id and
// the affected row count.
func write(ex executor, r *request) (lastID, affected int64, err error) {
	done, err := ex.enter()
	if err != nil {
		return 0, 0, err
	}
	defer done()
	d, ctx := ex.base(), ex.context()
	c, err := d.plan(r)
	if err != nil {
		return 0, 0, err
	}
	st := &c.plan.Steps[0]
	args, masks, err := d.args(st, r, nil)
	if err != nil {
		return 0, 0, err
	}
	stmt, err := ex.stmt(ctx, st.SQL)
	if err != nil {
		return 0, 0, err
	}
	start := time.Now()
	if r.ir.Kind == "insert" && strings.Contains(st.SQL, " RETURNING ") {
		err = mapDriverErr(stmt.QueryRowContext(ctx, args...).Scan(&lastID))
		d.emit(c, st.SQL, args, masks, start, err)
		if err != nil {
			return 0, 0, err
		}
		return lastID, 1, nil
	}
	res, err := stmt.ExecContext(ctx, args...)
	err = mapDriverErr(err)
	d.emit(c, st.SQL, args, masks, start, err)
	if err != nil {
		return 0, 0, err
	}
	affected, _ = res.RowsAffected()
	if r.ir.Kind == "insert" && len(r.ir.Rows) == 0 {
		lastID, _ = res.LastInsertId()
	}
	if r.ir.Kind == "update" && r.ir.Optimistic != nil && affected == 0 {
		return 0, 0, &ir.Error{Code: CodeOptimisticLock, Msg: "the row changed after it was read"}
	}
	return lastID, affected, nil
}
