// ormd serves the engine over a Unix domain socket for hosts that cannot
// link it in-process (PHP). Framing: 4-byte big-endian length + payload.
//
// S0 scope: "compile" frames only. Execution frames (query/tx) arrive in S1
// when ormd gains the Go executor.
//
// Request : {"op":"compile","ir":{...}}
// Response: {"plan":{...}} | {"error":{"code":..,"msg":..}}
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

	"github.com/maxkwon/orm/engine"
)

const maxFrame = 16 << 20

type request struct {
	Op string          `json:"op"`
	IR json.RawMessage `json:"ir"`
}

func main() {
	sock := flag.String("socket", "", "unix socket path (required)")
	flag.Parse()
	if *sock == "" {
		fmt.Fprintln(os.Stderr, "ormd: -socket is required")
		os.Exit(2)
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
	log.Printf("ormd: listening on %s", *sock)

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
		go serve(conn)
	}
}

func serve(conn net.Conn) {
	defer conn.Close()
	r := bufio.NewReaderSize(conn, 64<<10)
	w := bufio.NewWriterSize(conn, 64<<10)
	var hdr [4]byte
	for {
		if _, err := io.ReadFull(r, hdr[:]); err != nil {
			return // peer closed; nothing to roll back in S0
		}
		n := binary.BigEndian.Uint32(hdr[:])
		if n > maxFrame {
			return
		}
		buf := make([]byte, n)
		if _, err := io.ReadFull(r, buf); err != nil {
			return
		}
		resp := handle(buf)
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

func handle(frame []byte) []byte {
	var req request
	if err := json.Unmarshal(frame, &req); err != nil {
		return engine.ErrorJSON(&engine.Error{Code: "FRAME_INVALID", Msg: err.Error()})
	}
	switch req.Op {
	case "compile":
		plan, err := engine.Compile(req.IR)
		if err != nil {
			return engine.ErrorJSON(err)
		}
		out := make([]byte, 0, len(plan)+10)
		out = append(out, `{"plan":`...)
		out = append(out, plan...)
		out = append(out, '}')
		return out
	case "exec":
		return handleExec(frame)
	case "exec_rel4":
		return handleRel4(frame)
	default:
		return engine.ErrorJSON(&engine.Error{Code: "OP_UNKNOWN", Msg: req.Op})
	}
}
