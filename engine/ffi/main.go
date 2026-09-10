// Package main builds libormengine (c-shared). Exported C ABI:
//
//	int orm_compile(const char* req, size_t req_len, char** resp, size_t* resp_len);
//	void orm_free(char* p);
//
// Return 0 on success (resp = plan JSON), 1 on compile error (resp = error
// JSON envelope). resp is malloc'd and must be released with orm_free.
package main

/*
#include <stdlib.h>
#include <string.h>
*/
import "C"

import (
	"runtime"
	"unsafe"

	"github.com/maxkwon/orm/engine"
)

func init() {
	// The library is loaded into a host process that has its own scheduler
	// (tokio, PHP-FPM worker). Keep the Go runtime footprint minimal.
	runtime.GOMAXPROCS(1)
}

func toC(b []byte, resp **C.char, respLen *C.size_t) {
	p := C.malloc(C.size_t(len(b)))
	C.memcpy(p, unsafe.Pointer(&b[0]), C.size_t(len(b)))
	*resp = (*C.char)(p)
	*respLen = C.size_t(len(b))
}

//export orm_compile
func orm_compile(req *C.char, reqLen C.size_t, resp **C.char, respLen *C.size_t) C.int {
	in := unsafe.Slice((*byte)(unsafe.Pointer(req)), int(reqLen))
	out, err := engine.Compile(in)
	if err != nil {
		toC(engine.ErrorJSON(err), resp, respLen)
		return 1
	}
	toC(out, resp, respLen)
	return 0
}

//export orm_free
func orm_free(p *C.char) {
	C.free(unsafe.Pointer(p))
}

func main() {}
