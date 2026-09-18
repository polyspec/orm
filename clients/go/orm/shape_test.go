package orm

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/polyspec/orm/engine/ir"
)

// TestShapeCoversEveryField mutates every reachable field of ir.Request (through
// pointers, slices and maps, two levels into the recursive group/query types)
// and requires each mutation to change the shape key and to differ from every
// other mutation. A field added to the IR that shapeKey does not walk fails here.
func TestShapeCoversEveryField(t *testing.T) {
	base := shapeKey(&ir.Request{})
	seen := map[uint64]string{}
	jsons := map[string]string{}
	var req ir.Request
	eachMutation(reflect.ValueOf(&req).Elem(), "", 0, func(path string) {
		k := shapeKey(&req)
		if k == base {
			t.Errorf("%s: mutation does not change the shape key", path)
		}
		if prev, dup := seen[k]; dup {
			t.Errorf("%s: same shape key as %s", path, prev)
		}
		seen[k] = path
		js, _ := json.Marshal(&req)
		if prev, dup := jsons[string(js)]; dup {
			t.Errorf("%s: mutation is not visible in JSON either (same as %s) — the test itself is off", path, prev)
		}
		jsons[string(js)] = path
	})
	if len(seen) < 60 {
		t.Errorf("only %d mutations were tried", len(seen))
	}
}

// eachMutation sets v (or, for composites, each leaf under it) to a non-zero
// value, calls fn, and restores the zero value.
func eachMutation(v reflect.Value, path string, depth int, fn func(string)) {
	if depth > 14 {
		return
	}
	switch v.Kind() {
	case reflect.String:
		v.SetString("x")
		fn(path)
		v.SetString("")
	case reflect.Int:
		v.SetInt(7)
		fn(path)
		v.SetInt(0)
	case reflect.Bool:
		v.SetBool(true)
		fn(path)
		v.SetBool(false)
	case reflect.Pointer:
		v.Set(reflect.New(v.Type().Elem()))
		fn(path + "!") // presence alone
		eachMutation(v.Elem(), path, depth+1, fn)
		v.Set(reflect.Zero(v.Type()))
	case reflect.Slice:
		v.Set(reflect.MakeSlice(v.Type(), 1, 1))
		fn(path + "[]")
		eachMutation(v.Index(0), path+"[0]", depth+1, fn)
		v.Set(reflect.Zero(v.Type()))
	case reflect.Map:
		m := reflect.MakeMap(v.Type())
		m.SetMapIndex(reflect.ValueOf("k"), reflect.Zero(v.Type().Elem()))
		v.Set(m)
		fn(path + "{}")
		elem := reflect.New(v.Type().Elem()).Elem()
		eachMutation(elem, path+"{k}", depth+1, func(p string) {
			m.SetMapIndex(reflect.ValueOf("k"), elem)
			fn(p)
		})
		v.Set(reflect.Zero(v.Type()))
	case reflect.Struct:
		for i := 0; i < v.NumField(); i++ {
			eachMutation(v.Field(i), path+"."+v.Type().Field(i).Name, depth+1, fn)
		}
	default:
		panic("eachMutation: unhandled kind " + v.Kind().String() + " at " + path)
	}
}

func TestShapeIgnoresParamValues(t *testing.T) {
	a := &request{}
	b := &request{}
	for _, r := range []*request{a, b} {
		r.ir.Kind = "all"
		r.ir.Entity = "battle"
		i := r.param(int64(len(r.params)))
		r.ir.Where = &ir.Group{Items: []ir.Item{{Pred: &ir.Pred{Column: "seq", Op: "eq", P: &i}}}}
	}
	a.params[0], b.params[0] = int64(1), int64(2)
	if shapeKey(&a.ir) != shapeKey(&b.ir) {
		t.Error("different param values must share a shape")
	}
	if PlanID(0x1f) != "000000000000001f" {
		t.Errorf("PlanID: %s", PlanID(0x1f))
	}
}
