// ormd serves the compiler over a Unix domain socket for hosts that cannot
// link it in-process (PHP). It never touches a database.
//
// Framing: 4-byte big-endian length + payload, both directions.
// Request : {"op":"compile","ir":{...}} | {"op":"hash"}   (hash answers {"schema_hash", "dialect"})
// Response: {"plan":{...}} | {"schema_hash":"…"} | {"error":{"code":..,"msg":..}}
package main

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/signal"
	"syscall"

	"github.com/polyspec/orm/engine"
	"github.com/polyspec/orm/engine/ir"
)

const maxFrame = 16 << 20

type request struct {
	Op string          `json:"op"`
	IR json.RawMessage `json:"ir"`
}

func main() {
	sock := flag.String("socket", "", "unix socket path (required, absolute)")
	schemaPath := flag.String("schema", "", "schema.json path (required)")
	dialect := flag.String("dialect", "mysql", "sql dialect")
	flag.Parse()
	if *sock == "" || *schemaPath == "" {
		fmt.Fprintln(os.Stderr, "ormd: -socket and -schema are required")
		os.Exit(2)
	}
	js, err := os.ReadFile(*schemaPath)
	if err != nil {
		log.Fatalf("ormd: %v", err)
	}
	eng, err := engine.LoadJSON(js, *dialect)
	if err != nil {
		log.Fatalf("ormd: %v", err)
	}
	if err := os.Remove(*sock); err != nil && !errors.Is(err, os.ErrNotExist) {
		log.Fatalf("ormd: remove stale socket: %v", err)
	}
	ln, err := net.Listen("unix", *sock)
	if err != nil {
		log.Fatalf("ormd: listen: %v", err)
	}
	if err := os.Chmod(*sock, 0o600); err != nil {
		log.Fatalf("ormd: chmod: %v", err)
	}
	log.Printf("ormd: schema %s (hash %s), listening on %s", *schemaPath, eng.M.SchemaHash, *sock)

	go func() {
		c := make(chan os.Signal, 1)
		signal.Notify(c, syscall.SIGINT, syscall.SIGTERM)
		<-c
		ln.Close()
		os.Remove(*sock)
		os.Exit(0)
	}()

	for {
		conn, err := ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			log.Printf("ormd: accept: %v", err)
			continue
		}
		go serve(eng, conn)
	}
}

func serve(eng *engine.Engine, conn net.Conn) {
	defer conn.Close()
	r := bufio.NewReaderSize(conn, 64<<10)
	w := bufio.NewWriterSize(conn, 64<<10)
	var hdr [4]byte
	for {
		if _, err := io.ReadFull(r, hdr[:]); err != nil {
			return
		}
		n := binary.BigEndian.Uint32(hdr[:])
		if n > maxFrame {
			return
		}
		buf := make([]byte, n)
		if _, err := io.ReadFull(r, buf); err != nil {
			return
		}
		resp := handle(eng, buf)
		binary.BigEndian.PutUint32(hdr[:], uint32(len(resp)))
		if _, err := w.Write(hdr[:]); err != nil {
			return
		}
		if _, err := w.Write(resp); err != nil {
			return
		}
		if err := w.Flush(); err != nil {
			return
		}
	}
}

func handle(eng *engine.Engine, frame []byte) []byte {
	var req request
	if err := json.Unmarshal(frame, &req); err != nil {
		return engine.ErrorJSON(&ir.Error{Code: "FRAME_INVALID", Msg: err.Error()})
	}
	switch req.Op {
	case "compile":
		plan, err := eng.Compile(req.IR)
		if err != nil {
			return engine.ErrorJSON(err)
		}
		out := make([]byte, 0, len(plan)+10)
		out = append(out, `{"plan":`...)
		out = append(out, plan...)
		out = append(out, '}')
		return out
	case "hash":
		// the client checks both at startup: its generated hash and the dialect its PDO driver speaks
		return []byte(`{"schema_hash":"` + eng.M.SchemaHash + `","dialect":"` + eng.P.D.Name() + `"}`)
	default:
		return engine.ErrorJSON(&ir.Error{Code: "OP_UNKNOWN", Msg: req.Op})
	}
}
