package orm

import (
	"net/url"
	"strconv"
	"strings"
	"time"
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
}

// parseDSN reads the DSN URI; the scheme is the only database selector.
// statementTimeoutMs bounds every statement of the connection; zero keeps the
// server default. Every connection reads and writes datetime values in UTC
// (docs/dialects.md "Date and time"), so the timezone parameter accepts only
// UTC or +00:00.
func parseDSN(raw string, statementTimeoutMs int) (parsedDSN, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" {
		return parsedDSN{}, configErr("dsn must be a URI using mysql://, postgres://, or sqlite://")
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
		network, address := "tcp", u.Host
		if socket := q.Get("socket"); socket != "" {
			network, address = "unix", socket
			q.Del("socket")
		}
		q.Set("time_zone", quoteText("+00:00"))
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
		path := u.Path
		if !strings.HasPrefix(path, "/") {
			return parsedDSN{}, configErr("sqlite DSN must include an absolute database path")
		}
		// A write transaction begins with BEGIN IMMEDIATE and holds the
		// write lock from its start; a read-only transaction begins
		// deferred. The client selects the begin statement, so the DSN
		// does not accept _txlock.
		if q.Has("_txlock") {
			return parsedDSN{}, configErr("sqlite DSN does not accept _txlock; write transactions begin with BEGIN IMMEDIATE")
		}
		q.Set("_txlock", "immediate")
		pragmas := strings.Join(q["_pragma"], ",")
		if !strings.Contains(pragmas, "busy_timeout") {
			q.Add("_pragma", "busy_timeout("+strconv.Itoa(sqliteBusyTimeoutMs)+")")
		}
		if !strings.Contains(pragmas, "foreign_keys") {
			q.Add("_pragma", "foreign_keys(1)")
		}
		out.native = "file:" + path + "?" + q.Encode()
	default:
		return parsedDSN{}, configErr("unsupported DSN scheme %q; want mysql, postgres, or sqlite", u.Scheme)
	}
	return out, nil
}

// DriverFromDSN returns the database selected by a DSN URI.
func DriverFromDSN(raw string) (string, error) {
	parsed, err := parseDSN(raw, 0)
	return parsed.driver, err
}
