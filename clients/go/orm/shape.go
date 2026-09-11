package orm

import "github.com/maxkwon/orm/engine/ir"

// The plan cache is keyed by the request's shape: everything in the IR except
// the parameter values. shapeKey walks the ir.Request directly into an FNV-1a
// 64 hash instead of marshalling it to JSON first — no allocation per
// statement. Every field of every IR struct is fed in with a tag byte and a
// length prefix, so two requests hash alike only when their JSON would be
// identical (TestShapeCoversEveryField keeps the walk complete when the IR
// grows).
const (
	fnvOffset = 14695981039346656037
	fnvPrime  = 1099511628211
)

type shape struct{ h uint64 }

func shapeKey(r *ir.Request) uint64 {
	s := shape{h: fnvOffset}
	s.request(r)
	return s.h
}

// PlanID renders a plan cache key the way Event.PlanID carries it: 16 hex digits.
func PlanID(key uint64) string {
	const digits = "0123456789abcdef"
	var b [16]byte
	for i := 15; i >= 0; i-- {
		b[i] = digits[key&0xf]
		key >>= 4
	}
	return string(b[:])
}

func (s *shape) byte(b byte) {
	s.h ^= uint64(b)
	s.h *= fnvPrime
}

func (s *shape) int(v int) {
	u := uint64(v)
	for i := 0; i < 8; i++ {
		s.byte(byte(u))
		u >>= 8
	}
}

func (s *shape) bool(v bool) {
	if v {
		s.byte(1)
	} else {
		s.byte(0)
	}
}

func (s *shape) str(v string) {
	s.int(len(v))
	for i := 0; i < len(v); i++ {
		s.byte(v[i])
	}
}

func (s *shape) optInt(p *int) {
	if p == nil {
		s.byte(0)
		return
	}
	s.byte(1)
	s.int(*p)
}

func (s *shape) ints(vs []int) {
	s.int(len(vs))
	for _, v := range vs {
		s.int(v)
	}
}

func (s *shape) strs(vs []string) {
	s.int(len(vs))
	for _, v := range vs {
		s.str(v)
	}
}

// strMap hashes a map order-independently: each entry is hashed on its own and
// the entry hashes are summed, so no key sort (and no allocation) is needed.
func (s *shape) strMap(m map[string]string) {
	s.int(len(m))
	var sum uint64
	for k, v := range m {
		e := shape{h: fnvOffset}
		e.str(k)
		e.str(v)
		sum += e.h
	}
	s.int(int(sum))
}

func (s *shape) request(r *ir.Request) {
	s.int(r.IRVersion)
	s.str(r.SchemaHash)
	s.str(r.Kind)
	s.query(&r.Query)
	s.assigns(r.Set)
	s.assigns(r.OnDuplicate)
	if r.Optimistic == nil {
		s.byte(0)
	} else {
		s.byte(1)
		s.str(r.Optimistic.Column)
		s.int(r.Optimistic.P)
	}
	s.str(r.Agg)
	if r.Raw == nil {
		s.byte(0)
	} else {
		s.byte(1)
		s.str(r.Raw.SQL)
		s.ints(r.Raw.Ps)
	}
	s.bool(r.Debug)
	s.int(r.NParams)
}

func (s *shape) query(q *ir.Query) {
	s.str(q.Entity)
	if q.Columns == nil {
		s.byte(0)
	} else {
		s.byte(1)
		s.str(q.Columns.Mode)
		s.strs(q.Columns.Add)
		s.strs(q.Columns.Remove)
		s.strMap(q.Columns.As)
		s.strMap(q.Columns.Expr)
	}
	s.group(q.On)
	s.group(q.Where)
	s.group(q.Having)
	s.int(len(q.Joins))
	for _, j := range q.Joins {
		if j == nil {
			s.byte(0)
			continue
		}
		s.byte(1)
		s.str(j.Rel)
		s.str(j.Kind)
		s.queryPtr(j.Query)
	}
	s.int(len(q.Relations))
	for _, rl := range q.Relations {
		if rl == nil {
			s.byte(0)
			continue
		}
		s.byte(1)
		s.str(rl.Rel)
		s.queryPtr(rl.Query)
	}
	s.int(len(q.Order))
	for _, o := range q.Order {
		s.str(o.Column)
		s.str(o.Expr)
		s.bool(o.Desc)
	}
	s.strs(q.GroupBy)
	if q.Limit == nil {
		s.byte(0)
	} else {
		s.byte(1)
		s.int(q.Limit.Offset)
		s.int(q.Limit.Count)
	}
	s.bool(q.Distinct)
	s.str(q.ForceIdx)
	s.str(q.KeyBy)
	s.bool(q.Flatten)
	s.int(q.LimitPerParent)
	if q.IfParent == nil {
		s.byte(0)
	} else {
		s.byte(1)
		s.str(q.IfParent.Column)
		s.int(q.IfParent.P)
	}
	s.bool(q.DropChildKey)
	s.bool(q.NoCascadeDelete)
}

func (s *shape) queryPtr(q *ir.Query) {
	if q == nil {
		s.byte(0)
		return
	}
	s.byte(1)
	s.query(q)
}

func (s *shape) group(g *ir.Group) {
	if g == nil {
		s.byte(0)
		return
	}
	s.byte(1)
	s.str(g.Conn)
	s.int(len(g.Items))
	for i := range g.Items {
		it := &g.Items[i]
		if it.Pred == nil {
			s.byte(0)
		} else {
			s.byte(1)
			s.str(it.Pred.Conn)
			s.str(it.Pred.Column)
			s.str(it.Pred.Op)
			s.optInt(it.Pred.P)
			s.ints(it.Pred.Ps)
			if it.Pred.Ref == nil {
				s.byte(0)
			} else {
				s.byte(1)
				s.str(it.Pred.Ref.Path)
				s.str(it.Pred.Ref.Column)
			}
			s.str(it.Pred.Expr)
			s.strs(it.Pred.Match)
		}
		s.group(it.Group)
		if it.Nav == nil {
			s.byte(0)
		} else {
			s.byte(1)
			s.str(it.Nav.Conn)
			s.str(it.Nav.Rel)
			s.group(it.Nav.Group)
		}
	}
}

func (s *shape) assigns(as []ir.Assign) {
	s.int(len(as))
	for i := range as {
		a := &as[i]
		s.str(a.Column)
		s.optInt(a.P)
		s.bool(a.Null)
		s.str(a.Expr)
		s.ints(a.Ps)
		s.optInt(a.PlusP)
		s.optInt(a.MinusP)
	}
}
