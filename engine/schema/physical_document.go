package schema

import (
	"bytes"
	"errors"
	"strings"
)

// PhysicalDocument is an experimental document, not import authority.
type PhysicalDocument struct {
	Graph                            *PhysicalGraph
	Prefix, Suffix, Newline, Diagram string
}
type PhysicalDocumentError struct {
	line int
	path string
}

func (e *PhysicalDocumentError) Error() string { return "SCHEMA_INVALID" }
func (e *PhysicalDocumentError) Line() int     { return e.line }
func (e *PhysicalDocumentError) Path() string  { return e.path }
func documentError(line int, path string) error {
	return &PhysicalDocumentError{line: line, path: path}
}

func ParsePhysicalDocument(source []byte) (*PhysicalDocument, error) {
	r, err := LocatePhysicalEnvelope(source)
	if err != nil {
		var e *PhysicalEnvelopeError
		if errors.As(err, &e) {
			return nil, documentError(e.Line(), "")
		}
		return nil, err
	}
	prefix, suffix := string(source[:r.Start]), string(source[r.End:])
	newline := "\n"
	if bytes.HasSuffix(source[r.Start:r.Body], []byte("\r\n")) {
		newline = "\r\n"
	}
	line := bytes.Count(source[:r.Body], []byte("\n")) + 1
	position := r.Body
	next := func() ([]byte, bool) {
		if position >= r.Close {
			return nil, false
		}
		end := bytes.IndexByte(source[position:r.Close], '\n')
		if end < 0 {
			end = r.Close
		} else {
			end += position
		}
		stop := end
		if stop > position && source[stop-1] == '\r' {
			stop--
		}
		out := source[position:stop]
		position = end + 1
		return out, true
	}
	expect := func(expected string) error {
		actual, ok := next()
		if !ok || string(actual) != expected {
			return documentError(line, "")
		}
		line++
		return nil
	}
	for _, s := range []string{"erDiagram", "%% orm:physical-json 1"} {
		if err := expect(s); err != nil {
			return nil, err
		}
	}
	metadata, ok := next()
	if !ok || !bytes.HasPrefix(metadata, []byte("%% ")) {
		return nil, documentError(line, "")
	}
	graph, err := PhysicalGraphFromJSON(metadata[3:])
	if err != nil {
		var e *PhysicalGraphError
		if errors.As(err, &e) {
			return nil, documentError(line, e.Path())
		}
		return nil, err
	}
	line++
	if err := expect("%% orm:physical-json-end"); err != nil {
		return nil, err
	}
	var diagram strings.Builder
	diagram.WriteString("erDiagram\n")
	physicalProjection(graph, func(s string) bool {
		err = expect(s)
		if err != nil {
			return false
		}
		diagram.WriteString(s)
		diagram.WriteByte('\n')
		return true
	})
	if err != nil {
		return nil, err
	}
	if _, ok := next(); ok {
		return nil, documentError(line, "")
	}
	return &PhysicalDocument{Graph: graph, Prefix: prefix, Suffix: suffix, Newline: newline, Diagram: diagram.String()}, nil
}
func EmitPhysicalDocument(graph *PhysicalGraph, prefix, suffix, newline string) ([]byte, error) {
	if graph == nil || graph.value == nil || newline != "\n" && newline != "\r\n" || prefix != "" && !strings.HasSuffix(prefix, "\n") {
		return nil, documentError(0, "")
	}
	json, err := graph.JSON()
	if err != nil {
		return nil, err
	}
	var out bytes.Buffer
	out.WriteString(prefix)
	for _, s := range []string{"```mermaid orm-physical-v1", "erDiagram", "%% orm:physical-json 1"} {
		out.WriteString(s)
		out.WriteString(newline)
	}
	out.WriteString("%% ")
	out.Write(json)
	out.WriteString(newline)
	out.WriteString("%% orm:physical-json-end")
	out.WriteString(newline)
	physicalProjection(graph, func(s string) bool { out.WriteString(s); out.WriteString(newline); return true })
	out.WriteString("```")
	out.WriteString(newline)
	out.WriteString(suffix)
	r, err := LocatePhysicalEnvelope(out.Bytes())
	if err != nil {
		var e *PhysicalEnvelopeError
		if errors.As(err, &e) {
			return nil, documentError(e.Line(), "")
		}
		return nil, err
	}
	if r.Start != len(prefix) || string(out.Bytes()[r.End:]) != suffix {
		return nil, documentError(0, "")
	}
	return out.Bytes(), nil
}
