package orm

import (
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// sqliteBusyTimeoutMs is the time in milliseconds a SQLite connection waits
// for a lock when the DSN sets no _pragma=busy_timeout(ms).
const sqliteBusyTimeoutMs = 5000

// parsedDSN is a DSN URI split into the dialect, the native database/sql DSN,
// and the connection time zone.
type parsedDSN struct {
	driver   string
	native   string
	location *time.Location
	// sslCA is the ssl-ca path for ssl-mode=VERIFY_IDENTITY, and sslHost is the host name
	// that the server certificate must carry as its name. Both are empty if there is no TLS.
	sslCA   string
	sslHost string
	// markdown is the server address, corpus, and token of a markdown:// DSN. It is empty for other schemes.
	markdown markdownDSN
}

// parseDSN reads the DSN URI; the scheme is the only database selector.
// statementTimeoutMs bounds every statement of the connection; zero keeps the
// server default. Every connection reads and writes datetime values in UTC
// (docs/dialects.md "Date and time"), so the timezone parameter accepts only
// UTC or +00:00.

// mysqlSQLMode is the session sql_mode of every MySQL connection, so that a
// coercion, truncation or grouping result does not depend on the server's
// setting (tests/dsn/mysql-session.json, docs/config.md "Runtime connection").
const mysqlSQLMode = "STRICT_ALL_TABLES,ONLY_FULL_GROUP_BY,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION"

func parseDSN(raw string, statementTimeoutMs int) (parsedDSN, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" {
		return parsedDSN{}, configErr("dsn must be a URI using mysql://, postgres://, sqlite://, or markdown://")
	}
	q := u.Query()
	out := parsedDSN{driver: strings.ToLower(u.Scheme), location: time.UTC}
	if zone := q.Get("timezone"); zone != "" && zone != "UTC" && zone != "+00:00" {
		return parsedDSN{}, configErr("dsn timezone %s: every connection reads and writes datetime values in UTC", zone)
	}
	q.Del("timezone")
	switch out.driver {
	case "mysql":
		if u.Host == "" || strings.Trim(u.Path, "/") == "" {
			return parsedDSN{}, configErr("mysql DSN must include host and database")
		}
		if err := mysqlTLS(u, q, &out); err != nil {
			return parsedDSN{}, err
		}
		network, address := "tcp", u.Host
		if socket := q.Get("socket"); socket != "" {
			network, address = "unix", socket
			q.Del("socket")
		}
		q.Set("time_zone", quoteText("+00:00"))
		q.Set("sql_mode", quoteText(mysqlSQLMode))
		q.Set("clientFoundRows", "true")
		if statementTimeoutMs > 0 {
			// MySQL bounds SELECT statements with max_execution_time.
			q.Set("max_execution_time", strconv.Itoa(statementTimeoutMs))
		}
		// Datetime cells arrive as time.Time values; openSQL sets the driver
		// location to the connection time zone.
		q.Set("parseTime", "true")
		auth := ""
		if u.User != nil {
			auth = u.User.Username()
			if password, ok := u.User.Password(); ok {
				auth += ":" + password
			}
		}
		out.native = auth + "@" + network + "(" + address + ")/" + strings.TrimPrefix(u.Path, "/") + "?" + q.Encode()
	case "postgres":
		if u.Host == "" && q.Get("host") == "" || strings.Trim(u.Path, "/") == "" {
			return parsedDSN{}, configErr("postgres DSN must include host and database")
		}
		if statementTimeoutMs > 0 {
			options := q.Get("options")
			if options != "" {
				options += " "
			}
			q.Set("options", options+"-c statement_timeout="+strconv.Itoa(statementTimeoutMs))
		}
		q.Set("timezone", "UTC")
		// PostgreSQL reads the option string literally, so a space is
		// percent-encoded instead of the form encoder's plus sign.
		u.RawQuery = strings.ReplaceAll(q.Encode(), "+", "%20")
		out.native = u.String()
	case "sqlite":
		// url.Parse percent-decodes the path and rejects an invalid escape.
		path := u.Path
		if !strings.HasPrefix(path, "/") {
			return parsedDSN{}, configErr("sqlite DSN must include an absolute database path")
		}
		if strings.ContainsRune(path, 0) {
			return parsedDSN{}, configErr("sqlite DSN path must not contain a NUL byte")
		}
		if !utf8.ValidString(path) {
			return parsedDSN{}, configErr("sqlite DSN path must be UTF-8 after percent-decoding")
		}
		// A write transaction begins with BEGIN IMMEDIATE and holds the
		// write lock from its start; a read-only transaction begins
		// deferred. The client selects the begin statement, so the DSN
		// does not accept _txlock.
		if q.Has("_txlock") {
			return parsedDSN{}, configErr("sqlite DSN does not accept _txlock; write transactions begin with BEGIN IMMEDIATE")
		}
		pragmas := strings.Join(q["_pragma"], ",")
		if !strings.Contains(pragmas, "busy_timeout") {
			q.Add("_pragma", "busy_timeout("+strconv.Itoa(sqliteBusyTimeoutMs)+")")
		}
		if !strings.Contains(pragmas, "foreign_keys") {
			q.Add("_pragma", "foreign_keys(1)")
		}
		// SQLite percent-decodes the path of a file: URI again, so the decoded path
		// is escaped so that characters such as %, #, and ? stay in the file name as they are.
		out.native = "file:" + (&url.URL{Path: path}).EscapedPath() + "?" + q.Encode()
	case "markdown":
		if out.markdown, err = parseMarkdownDSN(u, q); err != nil {
			return parsedDSN{}, err
		}
	default:
		return parsedDSN{}, configErr("unsupported DSN scheme %q; want mysql, postgres, sqlite, or markdown", u.Scheme)
	}
	return out, nil
}

// mysqlTLS reads ssl-mode and ssl-ca of a MySQL DSN (docs/config.md):
// with ssl-mode=VERIFY_IDENTITY and the absolute path of the CA file in ssl-ca, TCP connects by host name,
// or neither is present. The driver must not read these as session variables, so
// the parameters are removed from the query.
func mysqlTLS(u *url.URL, q url.Values, out *parsedDSN) error {
	mode, hasMode := q["ssl-mode"]
	ca, hasCA := q["ssl-ca"]
	q.Del("ssl-mode")
	q.Del("ssl-ca")
	if !hasMode && !hasCA {
		return nil
	}
	if !hasMode || len(mode) != 1 || mode[0] != "VERIFY_IDENTITY" {
		return configErr("mysql DSN ssl-mode %q is not supported; the TLS mode is ssl-mode=VERIFY_IDENTITY with ssl-ca", strings.Join(mode, ","))
	}
	if !hasCA || len(ca) != 1 || ca[0] == "" {
		return configErr("mysql DSN ssl-mode=VERIFY_IDENTITY needs ssl-ca, the absolute path of the CA file")
	}
	if !strings.HasPrefix(ca[0], "/") {
		return configErr("mysql DSN ssl-ca %s is not an absolute path", ca[0])
	}
	if q.Has("socket") {
		return configErr("mysql DSN ssl-mode connects over TCP and does not accept socket")
	}
	// The identity check compares the host name with the certificate.
	if net.ParseIP(u.Hostname()) != nil {
		return configErr("mysql DSN ssl-mode=VERIFY_IDENTITY needs a host name, not the address %s", u.Hostname())
	}
	out.sslCA, out.sslHost = ca[0], u.Hostname()
	return nil
}

// DriverFromDSN returns the database selected by a DSN URI.
func DriverFromDSN(raw string) (string, error) {
	parsed, err := parseDSN(raw, 0)
	return parsed.driver, err
}
