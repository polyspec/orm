package dbspec

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// The rules of the set reader (docs/spec/dbspec.md "Document sets").
const (
	RuleSetFile      = "set.file"
	RuleSetSymlink   = "set.symlink"
	RuleSetJSON      = "set.json"
	RuleSetSchema    = "set.schema"
	RuleSetKey       = "set.key"
	RuleSetEmpty     = "set.empty"
	RuleSetPath      = "set.path"
	RuleSetDuplicate = "set.duplicate"
)

// SetFileName is the only name of a set file.
const SetFileName = "dbspec-set.json"

// setMaxDepth is the deepest nesting of the set file's JSON, the object counting as one.
const setMaxDepth = 64

// SetFile is one listed file of a document set: its joined path and its bytes.
type SetFile struct {
	Path  string
	Bytes []byte
}

// Set is a document set read from its set file: the owned documents and the
// external documents, each in written order.
type Set struct {
	Documents []SetFile
	External  []SetFile
}

// SetError is one error of the set reader: its rule, the path it concerns and a
// message that names that path.
type SetError struct {
	Rule    string
	Path    string
	Message string
}

func (e SetError) Error() string { return e.Rule + ": " + e.Message }

// entryKind is what an examination without following a symbolic link found.
type entryKind int

const (
	kindOther entryKind = iota
	kindDirectory
	kindRegular
	kindSymlink
)

// ReadSet reads the set file at path (docs/spec/dbspec.md "Document sets"): the set
// file, its JSON, the normal form and the components of each listed path, and
// the bytes and identity of each listed file, in that order. It returns the
// listed files, or the errors ordered by step, then by path. It never checks the
// bytes of a listed file; the caller gives them to ReadBytes with their path.
func ReadSet(path string) (Set, []SetError) {
	prefix, last := splitSetPath(path)
	root := setRoot(prefix)
	r := &setReader{listings: map[string]nameList{}}

	// Step 1: the set file.
	data, failure := r.readSetFile(path, root, last)
	if failure != nil {
		return Set{}, []SetError{*failure}
	}

	// Step 2: the JSON.
	documents, external, failure := parseSetJSON(path, data)
	if failure != nil {
		return Set{}, []SetError{*failure}
	}

	// Step 3: each path, documents first, in written order.
	type entry struct {
		joined   string
		external bool
	}
	var passed []entry
	var errs []SetError
	for _, list := range []struct {
		paths    []string
		external bool
	}{{documents, false}, {external, true}} {
		for _, written := range list.paths {
			if problem := normalFormProblem(written, list.external); problem != "" {
				errs = append(errs, SetError{Rule: RuleSetPath, Path: path, Message: fmt.Sprintf("%s: path %s %s", path, quoteJSON(written), problem)})
				continue
			}
			joined := prefix + written
			if failure := r.examinePath(prefix, root, written, joined, list.external); failure != nil {
				errs = append(errs, *failure)
				continue
			}
			passed = append(passed, entry{joined: joined, external: list.external})
		}
	}

	// Step 4: the read and the file identity of each path that passed step 3.
	var set Set
	var identities []os.FileInfo
	for _, e := range passed {
		data, info, err := readListedFile(e.joined)
		if err != nil {
			errs = append(errs, SetError{Rule: RuleSetFile, Path: e.joined, Message: fmt.Sprintf("%s cannot be read: %v", e.joined, err)})
			continue
		}
		duplicate := false
		for _, earlier := range identities {
			if os.SameFile(earlier, info) {
				duplicate = true
				break
			}
		}
		if duplicate {
			errs = append(errs, SetError{Rule: RuleSetDuplicate, Path: e.joined, Message: e.joined + " names a file that an earlier path names"})
			continue
		}
		identities = append(identities, info)
		file := SetFile{Path: e.joined, Bytes: data}
		if e.external {
			set.External = append(set.External, file)
		} else {
			set.Documents = append(set.Documents, file)
		}
	}
	if len(errs) > 0 {
		return Set{}, errs
	}
	if set.External == nil {
		set.External = []SetFile{}
	}
	return set, nil
}

// splitSetPath splits path after its last separator: `/`, or on Windows `/` or
// `\`. A Windows volume name such as `C:` stays in the prefix.
func splitSetPath(path string) (prefix, last string) {
	end := len(filepath.VolumeName(path))
	for i := len(path) - 1; i >= end; i-- {
		if os.IsPathSeparator(path[i]) {
			end = i + 1
			break
		}
	}
	return path[:end], path[end:]
}

// setRoot is the directory that the prefix names, written so that an
// examination without following a symbolic link examines the root itself: a
// trailing separator would make lstat follow a symbolic link at the root, so it
// is removed, except that a root of `/` stays `/`. An empty prefix is `.`.
func setRoot(prefix string) string {
	if prefix == "" {
		return "."
	}
	volume := filepath.VolumeName(prefix)
	rest := prefix[len(volume):]
	trimmed := rest
	for len(trimmed) > 0 && os.IsPathSeparator(trimmed[len(trimmed)-1]) {
		trimmed = trimmed[:len(trimmed)-1]
	}
	if trimmed == "" && rest != "" {
		trimmed = rest[:1]
	}
	if volume+trimmed == "" {
		return "."
	}
	return volume + trimmed
}

// setReader holds the directory listings of one read, so each directory is
// listed once.
type setReader struct {
	listings map[string]nameList
}

// listed reports whether name is a name that directory lists.
func (r *setReader) listed(directory, name string) (bool, error) {
	names, ok := r.listings[directory]
	if !ok {
		var err error
		if names, err = listNames(directory); err != nil {
			return false, err
		}
		r.listings[directory] = names
	}
	return names.has(name), nil
}

// readSetFile is step 1: the root and the set file, examined without following
// a symbolic link, and the set file read from one handle.
func (r *setReader) readSetFile(path, root, last string) ([]byte, *SetError) {
	fail := func(rule, message string) *SetError {
		return &SetError{Rule: rule, Path: path, Message: path + ": " + message}
	}
	if last != SetFileName {
		return nil, fail(RuleSetFile, "a set file is named "+SetFileName)
	}
	kind, err := examine(root)
	switch {
	case err != nil:
		return nil, fail(RuleSetFile, fmt.Sprintf("the root %s cannot be examined: %v", root, err))
	case kind == kindSymlink:
		return nil, fail(RuleSetSymlink, "the root "+root+" is a symbolic link")
	case kind != kindDirectory:
		return nil, fail(RuleSetFile, "the root "+root+" is not a directory")
	}
	listed, err := r.listed(root, last)
	if err != nil {
		return nil, fail(RuleSetFile, fmt.Sprintf("the root %s cannot be listed: %v", root, err))
	}
	if !listed {
		return nil, fail(RuleSetFile, "the root "+root+" lists no "+SetFileName)
	}
	kind, err = examine(path)
	switch {
	case err != nil:
		return nil, fail(RuleSetFile, fmt.Sprintf("cannot be examined: %v", err))
	case kind == kindSymlink:
		return nil, fail(RuleSetSymlink, "the set file is a symbolic link")
	case kind != kindRegular:
		return nil, fail(RuleSetFile, "the set file is not a regular file")
	}
	data, _, err := readListedFile(path)
	if err != nil {
		return nil, fail(RuleSetFile, fmt.Sprintf("cannot be read: %v", err))
	}
	return data, nil
}

// examinePath is step 3 after the normal form: each prefix of the joined path
// that ends after a segment of the written path. A segment other than `..` is
// first compared with the names its directory lists, then examined. An
// intermediate component of an external path may be a symbolic link to a
// directory, which is followed; every other link is refused.
func (r *setReader) examinePath(prefix, root, written, joined string, external bool) *SetError {
	fail := func(rule, message string) *SetError {
		return &SetError{Rule: rule, Path: joined, Message: joined + ": " + message}
	}
	segments := strings.Split(written, "/")
	directory := root
	for i, segment := range segments {
		component := prefix + strings.Join(segments[:i+1], "/")
		if segment != ".." {
			listed, err := r.listed(directory, segment)
			if err != nil {
				return fail(RuleSetFile, fmt.Sprintf("%s cannot be listed: %v", directory, err))
			}
			if !listed {
				return fail(RuleSetFile, fmt.Sprintf("%s lists no name %s", directory, quoteJSON(segment)))
			}
		}
		kind, err := examine(component)
		if err != nil {
			return fail(RuleSetFile, fmt.Sprintf("%s cannot be examined: %v", component, err))
		}
		if kind == kindSymlink && external && i < len(segments)-1 {
			if kind, err = examineFollowed(component); err != nil {
				return fail(RuleSetFile, fmt.Sprintf("%s cannot be examined: %v", component, err))
			}
		}
		if kind == kindSymlink {
			return fail(RuleSetSymlink, component+" is a symbolic link")
		}
		if i < len(segments)-1 {
			if kind != kindDirectory {
				return fail(RuleSetFile, component+" is not a directory")
			}
		} else if kind != kindRegular {
			return fail(RuleSetFile, component+" is not a regular file")
		}
		directory = component
	}
	return nil
}

// examineFollowed examines path following a symbolic link (stat), for an
// intermediate component of an external path.
func examineFollowed(path string) (entryKind, error) {
	info, err := os.Stat(path)
	if err != nil {
		return kindOther, err
	}
	switch {
	case info.IsDir():
		return kindDirectory, nil
	case info.Mode().IsRegular():
		return kindRegular, nil
	}
	return kindOther, nil
}

// readListedFile opens path once and takes its bytes and its identity from
// that handle.
func readListedFile(path string) (_ []byte, _ os.FileInfo, err error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	defer func() { err = errors.Join(err, f.Close()) }()
	data, err := io.ReadAll(f)
	if err != nil {
		return nil, nil, err
	}
	info, err := f.Stat()
	if err != nil {
		return nil, nil, err
	}
	return data, info, nil
}

// parseSetJSON is step 2. It returns the documents and the external paths or
// the first error.
func parseSetJSON(path string, data []byte) ([]string, []string, *SetError) {
	fail := func(rule, message string) *SetError {
		return &SetError{Rule: rule, Path: path, Message: path + ": " + message}
	}
	if bytes.HasPrefix(data, []byte("\xEF\xBB\xBF")) {
		return nil, nil, fail(RuleSetJSON, "the set file starts with a byte order mark")
	}
	if !utf8.Valid(data) {
		return nil, nil, fail(RuleSetJSON, "the set file is not valid UTF-8")
	}
	duplicate, err := checkSetJSON(data)
	if err != nil {
		return nil, nil, fail(RuleSetJSON, err.Error())
	}
	if duplicate != "" {
		return nil, nil, fail(RuleSetKey, "the key "+quoteJSON(duplicate)+" appears twice")
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(data, &object); err != nil {
		return nil, nil, fail(RuleSetJSON, err.Error())
	}
	var unknown []string
	for key := range object {
		if key != "schema" && key != "documents" && key != "external" {
			unknown = append(unknown, quoteJSON(key))
		}
	}
	if len(unknown) > 0 {
		sort.Strings(unknown)
		return nil, nil, fail(RuleSetKey, "unknown keys "+strings.Join(unknown, ", "))
	}
	schema, ok := object["schema"]
	if !ok {
		return nil, nil, fail(RuleSetSchema, "schema is missing")
	}
	if !isSchemaOne(schema) {
		return nil, nil, fail(RuleSetSchema, "schema is "+string(schema)+", not the number 1")
	}
	raw, ok := object["documents"]
	if !ok {
		return nil, nil, fail(RuleSetKey, "documents is missing")
	}
	documents, ok := stringArray(raw)
	if !ok {
		return nil, nil, fail(RuleSetKey, "documents is not an array of strings")
	}
	if len(documents) == 0 {
		return nil, nil, fail(RuleSetEmpty, "documents is empty")
	}
	external := []string{}
	if raw, ok := object["external"]; ok {
		if external, ok = stringArray(raw); !ok {
			return nil, nil, fail(RuleSetKey, "external is not an array of strings")
		}
	}
	return documents, external, nil
}

// checkSetJSON reads data with the decoder's tokens and checks that it is one
// JSON object nested at most setMaxDepth levels deep in which no string escapes
// a lone surrogate. It returns the first key that appears twice in one object,
// which is judged only when the JSON is valid.
func checkSetJSON(data []byte) (string, error) {
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	type frame struct {
		object    bool
		keys      map[string]bool
		expectKey bool // the next token of an object is a key or its end
	}
	var stack []*frame
	duplicate := ""
	for first := true; ; first = false {
		start := d.InputOffset()
		token, err := d.Token()
		if err == io.EOF {
			if first {
				return "", errors.New("the set file holds no JSON value")
			}
			if len(stack) > 0 {
				return "", errors.New("the set file is not JSON: it ends inside the object")
			}
			return duplicate, nil
		}
		if err != nil {
			return "", fmt.Errorf("the set file is not JSON: %w", err)
		}
		if first && token != json.Delim('{') {
			return "", errors.New("the set file is not one JSON object")
		}
		if !first && len(stack) == 0 {
			return "", errors.New("the set file holds more than one JSON value")
		}
		var top *frame
		if len(stack) > 0 {
			top = stack[len(stack)-1]
		}
		if s, ok := token.(string); ok && loneSurrogateEscape(data[start:d.InputOffset()]) {
			return "", fmt.Errorf("the string %s of the set file escapes a lone surrogate", quoteJSON(s))
		}
		switch token {
		case json.Delim('{'), json.Delim('['):
			stack = append(stack, &frame{object: token == json.Delim('{'), keys: map[string]bool{}, expectKey: true})
			if len(stack) > setMaxDepth {
				return "", fmt.Errorf("the set file nests deeper than %d levels", setMaxDepth)
			}
			continue
		case json.Delim('}'), json.Delim(']'):
			stack = stack[:len(stack)-1]
			if len(stack) > 0 && stack[len(stack)-1].object {
				stack[len(stack)-1].expectKey = true
			}
			continue
		}
		if top.object && top.expectKey {
			key, ok := token.(string)
			if !ok {
				return "", errors.New("the set file is not JSON: an object key is not a string")
			}
			if top.keys[key] && duplicate == "" {
				duplicate = key
			}
			top.keys[key] = true
			top.expectKey = false
		} else if top.object {
			top.expectKey = true
		}
	}
}

// loneSurrogateEscape reports whether raw, the bytes of one string token and
// the separators before it, escapes a surrogate that is not part of a pair. The
// decoder has already accepted the string, so every escape is well formed.
func loneSurrogateEscape(raw []byte) bool {
	i := bytes.IndexByte(raw, '"')
	if i < 0 {
		return false
	}
	s := raw[i+1:]
	unit := func(at int) (uint64, bool) {
		if at+6 > len(s) || s[at] != '\\' || s[at+1] != 'u' {
			return 0, false
		}
		v, err := strconv.ParseUint(string(s[at+2:at+6]), 16, 16)
		return v, err == nil
	}
	for j := 0; j < len(s); j++ {
		if s[j] == '"' {
			return false
		}
		if s[j] != '\\' {
			continue
		}
		if s[j+1] != 'u' {
			j++
			continue
		}
		v, _ := unit(j)
		switch {
		case v >= 0xD800 && v <= 0xDBFF:
			low, ok := unit(j + 6)
			if !ok || low < 0xDC00 || low > 0xDFFF {
				return true
			}
			j += 11
		case v >= 0xDC00 && v <= 0xDFFF:
			return true
		default:
			j += 5
		}
	}
	return false
}

// isSchemaOne reports whether raw is a JSON number whose value, read as a
// double, is 1. A number beyond the range of a double is not 1.
func isSchemaOne(raw json.RawMessage) bool {
	var n any
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	if err := d.Decode(&n); err != nil {
		return false
	}
	number, ok := n.(json.Number)
	if !ok {
		return false
	}
	v, err := strconv.ParseFloat(string(number), 64)
	return err == nil && v == 1
}

// stringArray decodes raw as an array of strings; null is not an array.
func stringArray(raw json.RawMessage) ([]string, bool) {
	if len(raw) == 0 || raw[0] != '[' {
		return nil, false
	}
	var values []any
	if err := json.Unmarshal(raw, &values); err != nil {
		return nil, false
	}
	out := make([]string, len(values))
	for i, v := range values {
		s, ok := v.(string)
		if !ok {
			return nil, false
		}
		out[i] = s
	}
	return out, true
}

// normalFormProblem says why written has no normal form, or is empty when it
// has one. An external path may begin with `..` segments.
func normalFormProblem(written string, external bool) string {
	segments := strings.Split(written, "/")
	leading := external
	for _, segment := range segments {
		if segment == ".." {
			if !leading {
				if external {
					return "has a .. segment after another segment"
				}
				return "of documents has a .. segment"
			}
			continue
		}
		leading = false
		if problem := segmentProblem(segment); problem != "" {
			return problem
		}
	}
	if !strings.HasSuffix(segments[len(segments)-1], ".dbs") {
		return "does not end in .dbs"
	}
	return ""
}

// segmentProblem says why segment is not a segment of the normal form.
func segmentProblem(segment string) string {
	if segment == "" {
		return "has an empty segment"
	}
	for _, c := range segment {
		if c < 0x20 || strings.ContainsRune(`/\:<>"|?*`, c) {
			return "has the character " + quoteJSON(string(c))
		}
	}
	if segment == "." {
		return "has a . segment"
	}
	if strings.HasSuffix(segment, ".") || strings.HasSuffix(segment, " ") {
		return "has a segment that ends in . or a space"
	}
	base, _, _ := strings.Cut(segment, ".")
	if isDeviceName(strings.TrimRight(base, " ")) {
		return "names a Windows device"
	}
	return ""
}

// isDeviceName reports whether name is, ignoring ASCII case, a device name of Windows.
func isDeviceName(name string) bool {
	upper := []byte(name)
	for i, c := range upper {
		if 'a' <= c && c <= 'z' {
			upper[i] = c - 'a' + 'A'
		}
	}
	switch s := string(upper); s {
	case "CON", "PRN", "AUX", "NUL":
		return true
	default:
		for _, prefix := range []string{"COM", "LPT"} {
			rest, ok := strings.CutPrefix(s, prefix)
			if !ok {
				continue
			}
			if len(rest) == 1 && '0' <= rest[0] && rest[0] <= '9' {
				return true
			}
			if rest == "¹" || rest == "²" || rest == "³" {
				return true
			}
		}
	}
	return false
}

// quoteJSON writes s as a JSON string without HTML escapes.
func quoteJSON(s string) string {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	if err := e.Encode(s); err != nil {
		return strconv.Quote(s)
	}
	return strings.TrimSuffix(b.String(), "\n")
}
