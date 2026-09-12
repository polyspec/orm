// ormd serves the compiler through Connect HTTP and the legacy Unix socket.
// It never accesses a database.
//
// Framing: 4-byte big-endian length + payload, both directions.
// Request : {"op":"compile","ir":{...}} | {"op":"hash"}   (hash answers {"schema_hash", "dialect"})
// Response: {"plan":{...}} | {"schema_hash":"…"} | {"error":{"code":..,"msg":..}}
package main

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/polyspec/orm/engine"
	"github.com/polyspec/orm/engine/ir"
	"github.com/polyspec/orm/proto/orm/compiler/v1/compilerv1connect"
)

const maxFrame = 16 << 20

type request struct {
	Op string          `json:"op"`
	IR json.RawMessage `json:"ir"`
}

func main() {
	sock := flag.String("socket", "", "unix socket path (required, absolute)")
	listen := flag.String("listen", "", "Connect HTTP listen address, for example 127.0.0.1:8080")
	schemaPath := flag.String("schema", "", "schema.json path (required)")
	dialect := flag.String("dialect", "mysql", "sql dialect")
	flag.Parse()
	if (*sock == "" && *listen == "") || *schemaPath == "" {
		fmt.Fprintln(os.Stderr, "ormd: -schema and at least one of -listen or -socket are required")
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
	var httpServer *http.Server
	if *listen != "" {
		path, handler := compilerv1connect.NewCompilerServiceHandler(&compilerServer{engine: eng})
		mux := http.NewServeMux()
		mux.Handle(path, handler)
		httpServer = &http.Server{Addr: *listen, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
		listener, err := net.Listen("tcp", *listen)
		if err != nil {
			log.Fatalf("ormd: Connect listen: %v", err)
		}
		log.Printf("ormd: schema %s (hash %s), Connect listening on http://%s%s", *schemaPath, eng.M.SchemaHash, listener.Addr(), path)
		go func() {
			if err := httpServer.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
				log.Printf("ormd: Connect serve: %v", err)
			}
		}()
	}
	if *sock == "" {
		waitForSignal(httpServer, nil, "")
		return
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

	go waitForSignal(httpServer, ln, *sock)

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

func waitForSignal(server *http.Server, listener net.Listener, socket string) {
	c := make(chan os.Signal, 1)
	signal.Notify(c, syscall.SIGINT, syscall.SIGTERM)
	<-c
	if server != nil {
		_ = server.Shutdown(context.Background())
	}
	if listener != nil {
		_ = listener.Close()
	}
	if socket != "" {
		_ = os.Remove(socket)
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
