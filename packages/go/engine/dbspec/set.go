package dbspec

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/polyspec/orm/packages/go/internal/message"
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
		external := list.external
		for _, written := range list.paths {
			if problem := normalFormProblem(written, external); problem != "" {
				list := "documents"
				if external {
					list = "external"
				}
				errs = append(errs, SetError{Rule: RuleSetPath, Path: path, Message: path + ": the " + list + " path " + message.Quote(written, '"') + " " + problem})
				continue
			}
			joined := prefix + written
			if failure := r.examinePath(prefix, root, written, joined, external); failure != nil {
				errs = append(errs, *failure)
				continue
			}
			passed = append(passed, entry{joined: joined, external: external})
		}
	}

	// Step 4: the read and the file identity of each path that passed step 3.
	var set Set
	type identity struct {
		joined string
		info   os.FileInfo
	}
	var identities []identity
	for _, e := range passed {
		data, info, err := readListedFile(e.joined)
		if err != nil {
			errs = append(errs, SetError{Rule: RuleSetFile, Path: e.joined, Message: e.joined + ": the file cannot be read: " + err.Error()})
			continue
		}
		earlier := ""
		for _, known := range identities {
			if os.SameFile(known.info, info) {
				earlier = known.joined
				break
			}
		}
		if earlier != "" {
			errs = append(errs, SetError{Rule: RuleSetDuplicate, Path: e.joined, Message: e.joined + ": names the file that " + earlier + " names"})
			continue
		}
		identities = append(identities, identity{joined: e.joined, info: info})
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
		return nil, fail(RuleSetFile, "the set file is not named "+SetFileName)
	}
	if strings.IndexByte(path, 0) >= 0 {
		return nil, fail(RuleSetFile, "the path contains a NUL byte")
	}
	kind, err := examine(root)
	switch {
	case err != nil:
		return nil, fail(RuleSetFile, "the root "+root+" cannot be examined: "+err.Error())
	case kind == kindSymlink:
		return nil, fail(RuleSetSymlink, "the root "+root+" is a symbolic link")
	case kind != kindDirectory:
		return nil, fail(RuleSetFile, "the root "+root+" is not a directory")
	}
	listed, err := r.listed(root, last)
	if err != nil {
		return nil, fail(RuleSetFile, "the root "+root+" cannot be listed: "+err.Error())
	}
	if !listed {
		return nil, fail(RuleSetFile, "the root "+root+" lists no "+SetFileName)
	}
	kind, err = examine(path)
	switch {
	case err != nil:
		return nil, fail(RuleSetFile, "the set file cannot be examined: "+err.Error())
	case kind == kindSymlink:
		return nil, fail(RuleSetSymlink, "the set file is a symbolic link")
	case kind != kindRegular:
		return nil, fail(RuleSetFile, "the set file is not a regular file")
	}
	data, _, err := readListedFile(path)
	if err != nil {
		return nil, fail(RuleSetFile, "the set file cannot be read: "+err.Error())
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
				return fail(RuleSetFile, directory+" cannot be listed: "+err.Error())
			}
			if !listed {
				return fail(RuleSetFile, directory+" lists no name "+message.Quote(segment, '"'))
			}
		}
		kind, err := examine(component)
		if err != nil {
			return fail(RuleSetFile, component+" cannot be examined: "+err.Error())
		}
		if kind == kindSymlink && external && i < len(segments)-1 {
			if kind, err = examineFollowed(component); err != nil {
				return fail(RuleSetFile, component+" cannot be examined: "+err.Error())
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
// the first error, checked in the order of DBS-13 and DBS-18a.
func parseSetJSON(path string, data []byte) ([]string, []string, *SetError) {
	fail := func(rule, text string) *SetError {
		return &SetError{Rule: rule, Path: path, Message: path + ": " + text}
	}
	if bytes.HasPrefix(data, []byte("\xEF\xBB\xBF")) {
		return nil, nil, fail(RuleSetJSON, "the set file starts with a byte order mark")
	}
	if !utf8.Valid(data) {
		return nil, nil, fail(RuleSetJSON, "the set file is not valid UTF-8")
	}
	// Unmarshal into a RawMessage checks the syntax of the whole text with the
	// parser's scanner and decodes no value, so a number beyond a double is JSON.
	var whole json.RawMessage
	if err := json.Unmarshal(data, &whole); err != nil {
		return nil, nil, fail(RuleSetJSON, "the set file is not JSON: "+err.Error())
	}
	if whole[0] != '{' {
		return nil, nil, fail(RuleSetJSON, "the set file is not one JSON object")
	}
	scan, err := scanSetJSON(data)
	if err != nil {
		return nil, nil, fail(RuleSetJSON, "the set file is not JSON: "+err.Error())
	}
	if scan.tooDeep {
		return nil, nil, fail(RuleSetJSON, fmt.Sprintf("the set file nests deeper than %d levels", setMaxDepth))
	}
	if scan.loneSurrogate {
		return nil, nil, fail(RuleSetJSON, "the set file escapes a lone surrogate")
	}
	if scan.duplicate != nil {
		return nil, nil, fail(RuleSetKey, "the key "+message.Quote(*scan.duplicate, '"')+" appears twice")
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(data, &object); err != nil {
		return nil, nil, fail(RuleSetJSON, "the set file is not JSON: "+err.Error())
	}
	var unknown []string
	for key := range object {
		if key != "schema" && key != "documents" && key != "external" {
			unknown = append(unknown, key)
		}
	}
	if len(unknown) > 0 {
		// The UTF-8 bytes of the keys sort in code-point order.
		slices.Sort(unknown)
		quoted := make([]string, len(unknown))
		for i, key := range unknown {
			quoted[i] = message.Quote(key, '"')
		}
		noun := "unknown key "
		if len(unknown) > 1 {
			noun = "unknown keys "
		}
		return nil, nil, fail(RuleSetKey, noun+strings.Join(quoted, ", "))
	}
	schema, ok := object["schema"]
	if !ok {
		return nil, nil, fail(RuleSetSchema, "schema is missing")
	}
	if !isSchemaOne(schema) {
		return nil, nil, fail(RuleSetSchema, "schema is not the number 1")
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

// setScan is what scanSetJSON found in a valid JSON object: whether it nests
// deeper than setMaxDepth, whether a string escapes a lone surrogate, and the
// first key, in text order, that repeats a key of its object.
type setScan struct {
	tooDeep       bool
	loneSurrogate bool
	duplicate     *string
}

// scanSetJSON reads data, which the parser has accepted as one JSON object, with
// the decoder's tokens. It stops at the first level deeper than setMaxDepth,
// since that check comes first.
func scanSetJSON(data []byte) (setScan, error) {
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	type frame struct {
		object    bool
		keys      map[string]bool
		expectKey bool // the next token of an object is a key or its end
	}
	var stack []*frame
	var scan setScan
	for {
		start := d.InputOffset()
		token, err := d.Token()
		if err == io.EOF {
			return scan, nil
		}
		if err != nil {
			return scan, err
		}
		if _, ok := token.(string); ok && loneSurrogateEscape(data[start:d.InputOffset()]) {
			scan.loneSurrogate = true
		}
		switch token {
		case json.Delim('{'), json.Delim('['):
			stack = append(stack, &frame{object: token == json.Delim('{'), keys: map[string]bool{}, expectKey: true})
			if len(stack) > setMaxDepth {
				scan.tooDeep = true
				return scan, nil
			}
			continue
		case json.Delim('}'), json.Delim(']'):
			stack = stack[:len(stack)-1]
			if len(stack) > 0 && stack[len(stack)-1].object {
				stack[len(stack)-1].expectKey = true
			}
			continue
		}
		top := stack[len(stack)-1]
		if top.object && top.expectKey {
			key, ok := token.(string)
			if !ok {
				return scan, errors.New("an object key is not a string")
			}
			if top.keys[key] && scan.duplicate == nil {
				scan.duplicate = &key
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
// has one: the first problem of DBS-18a, checking the segments from the first.
// An external path may begin with `..` segments.
func normalFormProblem(written string, external bool) string {
	segments := strings.Split(written, "/")
	leading := external
	for _, segment := range segments {
		if segment == "" {
			return "has an empty segment"
		}
		if segment == ".." {
			if !leading {
				if external {
					return "has a .. segment after another segment"
				}
				return "has a .. segment"
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

// segmentProblem says why a non-empty segment other than `..` is not a segment
// of the normal form.
func segmentProblem(segment string) string {
	if segment == "." {
		return "has a . segment"
	}
	for _, c := range segment {
		if c < 0x20 || strings.ContainsRune(`/\:<>"|?*`, c) {
			return "has the character " + message.Quote(string(c), '"') + " that a segment cannot hold"
		}
	}
	if strings.HasSuffix(segment, ".") || strings.HasSuffix(segment, " ") {
		return "has a segment that ends in . or a space"
	}
	base, _, _ := strings.Cut(segment, ".")
	if isDeviceName(strings.TrimRight(base, " ")) {
		return "has the segment " + message.Quote(segment, '"') + " that names a Windows device"
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
