package orm

import (
	"fmt"
	"net"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// sqlitePragma and sqliteBusyTimeout are the forms of a _pragma parameter: name(value), and a whole number of
// milliseconds for busy_timeout (docs/spec/config.md, CFG-12).
var (
	sqlitePragma      = regexp.MustCompile(`^[a-z_]+\([A-Za-z0-9_]+\)$`)
	sqliteBusyTimeout = regexp.MustCompile(`^busy_timeout\([0-9]+\)$`)
)

// validPragma reports whether pragma is a _pragma value of CFG-12: name(value), and a busy_timeout a decimal whole number
// from 0 to 2147483647, the largest wait the C int of SQLite holds; SQLite reads a larger number as 0.
func validPragma(pragma string) bool {
	if !sqlitePragma.MatchString(pragma) {
		return false
	}
	if !strings.HasPrefix(pragma, "busy_timeout(") {
		return true
	}
	if !sqliteBusyTimeout.MatchString(pragma) {
		return false
	}
	_, err := strconv.ParseInt(pragma[len("busy_timeout("):len(pragma)-1], 10, 32)
	return err == nil
}

// sqliteBusyTimeoutMs is the time in milliseconds a SQLite connection waits
// for a lock when the DSN sets no _pragma=busy_timeout(ms).
const sqliteBusyTimeoutMs = 5000

// parsedDSN is a DSN URI split into the dialect, the native database/sql DSN,
// and the connection time zone.
type parsedDSN struct {
	driver   string
	native   string
	location *time.Location
	// sslCA is the ssl-ca path for ssl-mode=VERIFY_IDENTITY of MySQL or the sslrootcert path for sslmode=verify-full
	// of PostgreSQL, and sslHost is the host name that a MySQL server certificate must carry as its name. Both are empty
	// if there is no TLS.
	sslCA   string
	sslHost string
	// markdown is the server address, corpus, and token of a markdown:// DSN. It is empty for other schemes.
	markdown markdownDSN
	// statementTimeoutMs is the statement bound of a mysql connection, which names the variable of its server (DIA-208), so
	// native carries it only after the server is read (withStatementTimeout); zero elsewhere.
	statementTimeoutMs int
}

// withStatementTimeout returns the mysql DSN whose every connection sets the statement bound by the variable of server, at
// connect and before any statement of the caller (DIA-208): MySQL bounds SELECT statements with max_execution_time in
// milliseconds, MariaDB every statement with max_statement_time in seconds, written with three fraction digits.
func (d parsedDSN) withStatementTimeout(server string) parsedDSN {
	name, value := "max_execution_time", strconv.Itoa(d.statementTimeoutMs)
	if server == serverMariaDB {
		name, value = "max_statement_time", fmt.Sprintf("%d.%03d", d.statementTimeoutMs/1000, d.statementTimeoutMs%1000)
	}
	d.native += "&" + name + "=" + value
	return d
}

// parseDSN reads the DSN URI; the scheme is the only database selector.
// statementTimeoutMs bounds every statement of the connection; zero keeps the
// server default. Every connection reads and writes datetime values in UTC
// (docs/spec/dialects.md "Date and time"), so the timezone parameter accepts only
// UTC or +00:00.

// mysqlSQLMode is the session sql_mode of every MySQL connection, so that a
// coercion, truncation or grouping result does not depend on the server's
// setting (case mysql_session_settings of contracts/fixtures/dsn_connection, docs/spec/config.md "Runtime connection").
const mysqlSQLMode = "STRICT_ALL_TABLES,ONLY_FULL_GROUP_BY,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION"

// dsnParameters are the parameters that each scheme accepts, in the order that
// its message names them (docs/spec/config.md, CFG-19; PRT-63 for markdown).
var dsnParameters = map[string][]string{
	"mysql":    {"timezone", "socket", "ssl-mode", "ssl-ca"},
	"postgres": {"timezone", "host", "sslmode", "sslrootcert"},
	"sqlite":   {"timezone", "_pragma", "_txlock"},
	"markdown": {"token", "timezone", "_pragma"},
}

// readDSNQuery reads the query of a DSN by the one rule of CFG-20: the pairs split
// at & and each at its first =, every name accepted by the scheme, none but
// _pragma repeated, each name and value decoded as an HTML form is and UTF-8, no
// value empty, and no socket or host value holding ; or NUL. It returns the
// decoded values of each name in written order.
func readDSNQuery(scheme, rawQuery string) (map[string][]string, error) {
	accepted := dsnParameters[scheme]
	values := map[string][]string{}
	if rawQuery == "" {
		return values, nil
	}
	// An empty pair has the name "", which no scheme accepts.
	for _, pair := range strings.Split(rawQuery, "&") {
		written, rawValue, hasValue := strings.Cut(pair, "=")
		name, ok := formDecode(written)
		if !ok {
			name = written
		}
		if !ok || !slices.Contains(accepted, name) {
			return nil, configErr("%s DSN has the unknown parameter %q; it accepts %s", scheme, name, strings.Join(accepted, ", "))
		}
		if _, seen := values[name]; seen && name != "_pragma" {
			return nil, configErr("%s DSN repeats the parameter %q", scheme, name)
		}
		value, ok := formDecode(rawValue)
		if !ok {
			return nil, configErr("%s DSN parameter %q is not percent-encoded UTF-8", scheme, name)
		}
		if !hasValue || value == "" {
			return nil, configErr("%s DSN parameter %q is empty", scheme, name)
		}
		if (name == "socket" || name == "host" || name == "sslrootcert") && strings.ContainsAny(value, ";\x00") {
			return nil, configErr("%s DSN parameter %q holds a character that a connection string cannot hold", scheme, name)
		}
		values[name] = append(values[name], value)
	}
	return values, nil
}

// formDecode decodes text as an HTML form does, + as a space and % with two
// hexadecimal digits as that byte; it reports false for a % that two
// hexadecimal digits do not follow and for bytes that are not UTF-8.
func formDecode(text string) (string, bool) {
	decoded, err := url.QueryUnescape(text)
	if err != nil || !utf8.ValidString(decoded) {
		return "", false
	}
	return decoded, true
}

// one is the value of a parameter that readDSNQuery has read, which no scheme but
// _pragma repeats, or empty when the DSN does not give it.
func one(values map[string][]string, name string) string {
	if v := values[name]; len(v) > 0 {
		return v[0]
	}
	return ""
}

// checkDSNParts checks a DSN of a known scheme in the order of CFG-20 before the URI parser, which would drop or decode
// these parts unread: a port that is not digits (no RFC 3986 URI), a fragment, the query by the pair rule, a host that
// holds a percent escape, a MySQL or PostgreSQL database path that is not percent-encoded UTF-8, named as written, or
// whose name holds ; or NUL, and a SQLite path that is not absolute, not percent-encoded UTF-8, or holds NUL. The values of the parameters are checked after it. A DSN of another form is left to the
// URI parser.
func checkDSNParts(raw string) error {
	scheme, authority, path, query, ok := dsnParts(raw)
	if !ok {
		return nil
	}
	host := authority
	at := strings.LastIndex(host, "@")
	if at >= 0 {
		host = host[at+1:]
	}
	if colon := strings.LastIndex(host, ":"); colon >= 0 && colon > strings.LastIndex(host, "]") {
		if strings.Trim(host[colon+1:], "0123456789") != "" {
			return configErr("dsn must be a URI using mysql://, postgres://, sqlite://, or markdown://")
		}
		host = host[:colon]
	}
	if strings.Contains(raw, "#") {
		return configErr("%s DSN has a fragment, which no connection reads", scheme)
	}
	values, err := readDSNQuery(scheme, query)
	if err != nil {
		return err
	}
	// The host step (CFG-10): the host named, no percent escape in it, then the socket host or the two hosts.
	name := strings.TrimSuffix(strings.TrimPrefix(host, "["), "]")
	parameter := one(values, "host")
	if scheme == "mysql" && name == "" || scheme == "postgres" && name == "" && parameter == "" {
		return configErr("%s DSN must include host and database", scheme)
	}
	if strings.Contains(host, "%") {
		// A markdown DSN checks the token and the user before its host (PRT-63); the URI parser refuses the escape, so
		// those checks are made here.
		if scheme == "markdown" && len(values["token"]) == 0 {
			return configErr("markdown DSN is missing the parameter %q", "token")
		}
		if scheme == "markdown" && at >= 0 {
			return configErr("%s; it takes no user", markdownForm)
		}
		return configErr("%s DSN host %q holds a percent escape, which no host name needs", scheme, host)
	}
	if _, socket := values["socket"]; scheme == "mysql" && socket && name != "localhost" {
		return configErr("mysql DSN socket needs the host localhost, which names the local server")
	}
	if scheme == "postgres" && name != "" && parameter != "" && name != parameter {
		return configErr("postgres DSN names two hosts, %q in the URL and %q in the host parameter", name, parameter)
	}
	// The database step: the database named, its escapes, then ; or NUL.
	if (scheme == "mysql" || scheme == "postgres") && len(path) <= 1 {
		return configErr("%s DSN must include host and database", scheme)
	}
	if scheme == "mysql" || scheme == "postgres" {
		decoded, ok := decodedPath(path)
		if !ok {
			return configErr("%s DSN database %q is not percent-encoded UTF-8", scheme, strings.TrimPrefix(path, "/"))
		}
		if err := checkDatabaseName(scheme, decoded); err != nil {
			return err
		}
	}
	// The database step of SQLite (CFG-11): an absolute path and no host, its escapes, then NUL, named as written.
	if scheme == "sqlite" {
		if name != "" || !strings.HasPrefix(path, "/") || path == "/" {
			return configErr("sqlite DSN must include an absolute database path")
		}
		decoded, ok := decodedPath(path)
		if !ok {
			return configErr("sqlite DSN path %q is not percent-encoded UTF-8", path)
		}
		if strings.ContainsRune(decoded, 0) {
			return configErr("sqlite DSN path %q holds a NUL byte, which a file name cannot hold", path)
		}
	}
	return nil
}

// dsnParts splits a DSN of a known scheme as written: the scheme in lower case, the authority, the path, and the query
// without its fragment; ok is false for a DSN of another form, which is left to the URI parser.
func dsnParts(raw string) (scheme, authority, path, query string, ok bool) {
	scheme, rest, found := strings.Cut(raw, "://")
	scheme = strings.ToLower(scheme)
	if _, known := dsnParameters[scheme]; !found || !known {
		return "", "", "", "", false
	}
	rest, _, _ = strings.Cut(rest, "#")
	end := strings.IndexAny(rest, "/?")
	if end < 0 {
		end = len(rest)
	}
	path, query, _ = strings.Cut(rest[end:], "?")
	return scheme, rest[:end], path, query, true
}

// decodedPath is a DSN path percent-decoded, + kept as itself; ok is false for a % without two hexadecimal digits or
// decoded bytes that are not UTF-8 (CFG-11, CFG-20). The path of every scheme is decoded by it.
func decodedPath(written string) (string, bool) {
	decoded, err := url.PathUnescape(written)
	return decoded, err == nil && utf8.ValidString(decoded)
}

func parseDSN(raw string, statementTimeoutMs int) (parsedDSN, error) {
	if err := checkDSNParts(raw); err != nil {
		return parsedDSN{}, err
	}
	// The path of a markdown DSN is its corpus, which PRT-63 checks after the token, the user, the host and the port, so
	// the URI parser reads the DSN without it: the parser would refuse a broken escape first.
	target := raw
	scheme, authority, markdownPath, query, _ := dsnParts(raw)
	if scheme == "markdown" {
		target = scheme + "://" + authority + "?" + query
	}
	u, err := url.Parse(target)
	if err != nil || u.Scheme == "" {
		return parsedDSN{}, configErr("dsn must be a URI using mysql://, postgres://, sqlite://, or markdown://")
	}
	out := parsedDSN{driver: strings.ToLower(u.Scheme), location: time.UTC}
	if _, ok := dsnParameters[out.driver]; !ok {
		return parsedDSN{}, configErr("unsupported DSN scheme %q; want mysql, postgres, sqlite, or markdown", u.Scheme)
	}
	// The query is read before any value is used, and the driver gets only the
	// values below, never the query (CFG-19, CFG-20, CFG-37).
	q, err := readDSNQuery(out.driver, u.RawQuery)
	if err != nil {
		return parsedDSN{}, err
	}
	if out.driver == "markdown" {
		if out.markdown, err = parseMarkdownDSN(u, markdownPath, q); err != nil {
			return parsedDSN{}, err
		}
	}
	if zone := one(q, "timezone"); zone != "" && zone != "UTC" && zone != "+00:00" {
		return parsedDSN{}, configErr("dsn timezone %q: every connection reads and writes datetime values in UTC", zone)
	}
	switch out.driver {
	case "markdown":
		for _, pragma := range q["_pragma"] {
			if !validPragma(pragma) {
				return parsedDSN{}, configErr("markdown DSN _pragma %q is invalid", pragma)
			}
		}
	case "mysql":
		if u.Host == "" || strings.Trim(u.Path, "/") == "" {
			return parsedDSN{}, configErr("mysql DSN must include host and database")
		}
		if err := mysqlTLS(u, q, &out); err != nil {
			return parsedDSN{}, err
		}
		network, address := "tcp", u.Host
		if socket := one(q, "socket"); socket != "" {
			network, address = "unix", socket
		}
		native := url.Values{}
		native.Set("time_zone", quoteText("+00:00"))
		native.Set("sql_mode", quoteText(mysqlSQLMode))
		native.Set("clientFoundRows", "true")
		// The statement bound is the variable of the server, which the connection reads after it opens (DIA-208).
		out.statementTimeoutMs = statementTimeoutMs
		// Datetime cells arrive as time.Time values; openSQL sets the driver
		// location to the connection time zone.
		native.Set("parseTime", "true")
		auth := ""
		if u.User != nil {
			auth = u.User.Username()
			if password, ok := u.User.Password(); ok {
				auth += ":" + password
			}
		}
		out.native = auth + "@" + network + "(" + address + ")/" + strings.TrimPrefix(u.Path, "/") + "?" + native.Encode()
	case "postgres":
		host := one(q, "host")
		if u.Host == "" && host == "" || strings.Trim(u.Path, "/") == "" {
			return parsedDSN{}, configErr("postgres DSN must include host and database")
		}
		native := url.Values{}
		if host != "" {
			native.Set("host", host)
		}
		if err := postgresTLS(q, host, native, &out); err != nil {
			return parsedDSN{}, err
		}
		if statementTimeoutMs > 0 {
			native.Set("options", "-c statement_timeout="+strconv.Itoa(statementTimeoutMs))
		}
		native.Set("timezone", "UTC")
		// PostgreSQL reads the option string literally, so a space is
		// percent-encoded instead of the form encoder's plus sign.
		out.native = (&url.URL{Scheme: "postgres", User: u.User, Host: u.Host, Path: u.Path, RawPath: u.RawPath, RawQuery: strings.ReplaceAll(native.Encode(), "+", "%20")}).String()
	case "sqlite":
		// checkDSNParts checked the path in the database step; url.Parse gives it percent-decoded.
		path := u.Path
		for _, pragma := range q["_pragma"] {
			if !validPragma(pragma) {
				return parsedDSN{}, configErr("sqlite DSN _pragma %q is invalid", pragma)
			}
		}
		// A write transaction begins with BEGIN IMMEDIATE and holds the
		// write lock from its start; a read-only transaction begins
		// deferred. The client selects the begin statement, so the DSN
		// does not accept _txlock. _pragma is checked first, in the CFG-19 order (CFG-20).
		if _, ok := q["_txlock"]; ok {
			return parsedDSN{}, configErr("sqlite DSN does not accept _txlock; write transactions begin with BEGIN IMMEDIATE")
		}
		native := url.Values{"_pragma": slices.Clone(q["_pragma"])}
		pragmas := strings.Join(q["_pragma"], ",")
		if !strings.Contains(pragmas, "busy_timeout") {
			native.Add("_pragma", "busy_timeout("+strconv.Itoa(sqliteBusyTimeoutMs)+")")
		}
		if !strings.Contains(pragmas, "foreign_keys") {
			native.Add("_pragma", "foreign_keys(1)")
		}
		// SQLite percent-decodes the path of a file: URI again, so the decoded path
		// is escaped so that characters such as %, #, and ? stay in the file name as they are.
		out.native = "file:" + (&url.URL{Path: path}).EscapedPath() + "?" + native.Encode()
	}
	return out, nil
}

// checkDatabaseName refuses a database name, the percent-decoded path of a MySQL or PostgreSQL DSN, that holds ; or NUL,
// which a connection string cannot hold (CFG-20).
func checkDatabaseName(scheme, path string) error {
	database := strings.TrimPrefix(path, "/")
	if strings.ContainsAny(database, ";\x00") {
		return configErr("%s DSN database %q holds a character that a connection string cannot hold", scheme, database)
	}
	return nil
}

// mysqlTLS reads ssl-mode and ssl-ca of a MySQL DSN (docs/spec/config.md):
// with ssl-mode=VERIFY_IDENTITY and the absolute path of the CA file in ssl-ca, TCP connects by host name,
// or neither is present. The driver gets neither as a parameter; openSQL sets its TLS from them.
func mysqlTLS(u *url.URL, q map[string][]string, out *parsedDSN) error {
	mode, hasMode := q["ssl-mode"]
	ca, hasCA := q["ssl-ca"]
	if !hasMode && !hasCA {
		return nil
	}
	if !hasMode || mode[0] != "VERIFY_IDENTITY" {
		return configErr("mysql DSN ssl-mode %q is not supported; the TLS mode is ssl-mode=VERIFY_IDENTITY with ssl-ca", strings.Join(mode, ","))
	}
	if !hasCA {
		return configErr("mysql DSN ssl-mode=VERIFY_IDENTITY needs ssl-ca, the absolute path of the CA file")
	}
	if !strings.HasPrefix(ca[0], "/") {
		return configErr("mysql DSN ssl-ca %q is not an absolute path", ca[0])
	}
	if _, ok := q["socket"]; ok {
		return configErr("mysql DSN ssl-mode connects over TCP and does not accept socket")
	}
	// The identity check compares the host name with the certificate.
	if net.ParseIP(u.Hostname()) != nil {
		return configErr("mysql DSN ssl-mode=VERIFY_IDENTITY needs a host name, not the address %s", u.Hostname())
	}
	out.sslCA, out.sslHost = ca[0], u.Hostname()
	return nil
}

// postgresTLS reads sslmode and sslrootcert of a PostgreSQL DSN in the order of CFG-46: with sslmode=verify-full and the
// absolute path of the CA file in sslrootcert, TCP connects with TLS that checks the certificate against that file alone
// and the host against the certificate (CFG-45); without either, or with sslmode=disable, it connects without TLS (CFG-47).
func postgresTLS(q map[string][]string, host string, native url.Values, out *parsedDSN) error {
	mode := one(q, "sslmode")
	ca, hasCA := q["sslrootcert"]
	if mode != "" && mode != "disable" && mode != "verify-full" {
		return configErr("postgres DSN sslmode %q is not supported; it accepts disable, or verify-full with sslrootcert", mode)
	}
	if hasCA && mode != "verify-full" {
		return configErr("postgres DSN sslrootcert needs sslmode=verify-full")
	}
	if mode != "verify-full" {
		native.Set("sslmode", "disable")
		return nil
	}
	if !hasCA {
		return configErr("postgres DSN sslmode=verify-full needs sslrootcert, the absolute path of the CA file")
	}
	if !strings.HasPrefix(ca[0], "/") {
		return configErr("postgres DSN sslrootcert %q is not an absolute path", ca[0])
	}
	if strings.HasPrefix(host, "/") {
		return configErr("postgres DSN sslmode=verify-full connects over TCP and does not accept a socket directory as host")
	}
	// pgx reads the CA file of sslrootcert alone for verify-full, and checks the host against the certificate.
	native.Set("sslmode", "verify-full")
	native.Set("sslrootcert", ca[0])
	out.sslCA = ca[0]
	return nil
}

// DriverFromDSN returns the database selected by a DSN URI.
func DriverFromDSN(raw string) (string, error) {
	parsed, err := parseDSN(raw, 0)
	return parsed.driver, err
}
