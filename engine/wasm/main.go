// Package main builds ormengine.wasm (wasip1 reactor). Exports:
//
//	orm_alloc(n) -> ptr             host allocates request bytes in linear memory
//	orm_load(ptr, len) -> ptr       schema.json (mysql dialect); result = [u32 status][u32 len][bytes]
//	orm_load_dialect(ptr, len, dptr, dlen) -> ptr   same with the dialect name in a second buffer
//	orm_compile(ptr, len) -> ptr    result = [u32 status][u32 len][bytes...]
//	orm_free(ptr)                   release a buffer returned by orm_alloc/orm_load/orm_compile
//
// go:wasmexport allows at most one result, hence the length-prefixed result.
package main

import (
	"encoding/binary"
	"unsafe"

	"github.com/maxkwon/orm/engine"
	"github.com/maxkwon/orm/engine/ir"
)

// buffers keeps every handed-out allocation reachable so the GC cannot move
// or free it while the host holds the pointer.
var buffers = map[uintptr][]byte{}

//go:wasmexport orm_alloc
func orm_alloc(n uint32) uint32 {
	b := make([]byte, n)
	p := uintptr(unsafe.Pointer(unsafe.SliceData(b)))
	buffers[p] = b
	return uint32(p)
}

//go:wasmexport orm_free
func orm_free(p uint32) {
	delete(buffers, uintptr(p))
}

func result(status uint32, out []byte) uint32 {
	res := make([]byte, 8+len(out))
	binary.LittleEndian.PutUint32(res[0:4], status)
	binary.LittleEndian.PutUint32(res[4:8], uint32(len(out)))
	copy(res[8:], out)
	rp := uintptr(unsafe.Pointer(unsafe.SliceData(res)))
	buffers[rp] = res
	return uint32(rp)
}

func input(p, n uint32) ([]byte, error) {
	buf, ok := buffers[uintptr(p)]
	if !ok || int(n) > len(buf) {
		return nil, &ir.Error{Code: "FRAME_INVALID", Msg: "request buffer not from orm_alloc"}
	}
	return buf[:n], nil
}

//go:wasmexport orm_load
func orm_load(p uint32, n uint32) uint32 {
	in, err := input(p, n)
	if err != nil {
		return result(1, engine.ErrorJSON(err))
	}
	e, err := engine.LoadJSON(in, "mysql")
	if err != nil {
		return result(1, engine.ErrorJSON(err))
	}
	engine.SetGlobal(e)
	return result(0, nil)
}

// orm_load_dialect is orm_load with the dialect in a second buffer ("mysql" |
// "postgres" | "sqlite"); orm_load stays the MySQL shorthand.
//
//go:wasmexport orm_load_dialect
func orm_load_dialect(p uint32, n uint32, dp uint32, dn uint32) uint32 {
	in, err := input(p, n)
	if err != nil {
		return result(1, engine.ErrorJSON(err))
	}
	d, err := input(dp, dn)
	if err != nil {
		return result(1, engine.ErrorJSON(err))
	}
	e, err := engine.LoadJSON(in, string(d))
	if err != nil {
		return result(1, engine.ErrorJSON(err))
	}
	engine.SetGlobal(e)
	return result(0, nil)
}

//go:wasmexport orm_compile
func orm_compile(p uint32, n uint32) uint32 {
	in, err := input(p, n)
	if err != nil {
		return result(1, engine.ErrorJSON(err))
	}
	e, err := engine.Global()
	if err != nil {
		return result(1, engine.ErrorJSON(err))
	}
	out, err := e.Compile(in)
	if err != nil {
		return result(1, engine.ErrorJSON(err))
	}
	return result(0, out)
}

func main() {}
