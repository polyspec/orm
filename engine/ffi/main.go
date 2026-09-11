// Package main builds libormengine (c-shared). Exported C ABI:
//
//	int  orm_load(const char* schema_json, size_t len, const char* dialect, char** err, size_t* err_len);
//	int  orm_compile(const char* req, size_t req_len, char** resp, size_t* resp_len);
//	void orm_free(char* p);
//
// orm_load must be called once per process with schema.json. orm_compile
// returns 0 with plan JSON, or 1 with an error envelope. Buffers returned via
// out-params are malloc'd and must be released with orm_free.
package main

/*
#include <stdlib.h>
#include <string.h>
*/
import "C"

import (
	"runtime"
	"unsafe"

	"github.com/polyspec/orm/engine"
)

func init() {
	// Loaded into a host process with its own scheduler; keep the Go runtime small.
	runtime.GOMAXPROCS(1)
}

func toC(b []byte, out **C.char, outLen *C.size_t) {
	if len(b) == 0 {
		*out = nil
		*outLen = 0
		return
	}
	p := C.malloc(C.size_t(len(b)))
	C.memcpy(p, unsafe.Pointer(&b[0]), C.size_t(len(b)))
	*out = (*C.char)(p)
	*outLen = C.size_t(len(b))
}

//export orm_load
func orm_load(schema *C.char, schemaLen C.size_t, dialect *C.char, errOut **C.char, errLen *C.size_t) C.int {
	js := unsafe.Slice((*byte)(unsafe.Pointer(schema)), int(schemaLen))
	e, err := engine.LoadJSON(js, C.GoString(dialect))
	if err != nil {
		toC(engine.ErrorJSON(err), errOut, errLen)
		return 1
	}
	engine.SetGlobal(e)
	return 0
}

//export orm_compile
func orm_compile(req *C.char, reqLen C.size_t, resp **C.char, respLen *C.size_t) C.int {
	e, err := engine.Global()
	if err != nil {
		toC(engine.ErrorJSON(err), resp, respLen)
		return 1
	}
	in := unsafe.Slice((*byte)(unsafe.Pointer(req)), int(reqLen))
	out, err := e.Compile(in)
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
