// Package main builds ormengine.wasm (wasip1 reactor). Exports:
//
//	orm_alloc(n) -> ptr           host allocates request bytes in linear memory
//	orm_compile(ptr, len) -> ptr  result is [u32 status][u32 len][bytes...]
//	orm_free(ptr)                 release a buffer returned by orm_alloc/orm_compile
//
// go:wasmexport allows at most one result, hence the length-prefixed result.
package main

import (
	"encoding/binary"
	"unsafe"

	"github.com/maxkwon/orm/engine"
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

//go:wasmexport orm_compile
func orm_compile(p uint32, n uint32) uint32 {
	// The request buffer must come from orm_alloc, so resolve it through the
	// registry instead of casting an integer to a pointer.
	buf, ok := buffers[uintptr(p)]
	status := uint32(0)
	var out []byte
	var err error
	if !ok || int(n) > len(buf) {
		err = &engine.Error{Code: "FRAME_INVALID", Msg: "request buffer not from orm_alloc"}
	} else {
		out, err = engine.Compile(buf[:n])
	}
	if err != nil {
		status = 1
		out = engine.ErrorJSON(err)
	}
	res := make([]byte, 8+len(out))
	binary.LittleEndian.PutUint32(res[0:4], status)
	binary.LittleEndian.PutUint32(res[4:8], uint32(len(out)))
	copy(res[8:], out)
	rp := uintptr(unsafe.Pointer(unsafe.SliceData(res)))
	buffers[rp] = res
	return uint32(rp)
}

func main() {}
