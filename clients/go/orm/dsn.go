package orm

import (
	"net/url"
	"strconv"
	"strings"
	"time"
)

// parsedDSN is a DSN URI split into the dialect, the native database/sql DSN,
// and the connection time zone.
type parsedDSN struct {
	driver   string
	native   string
	location *time.Location
}

// parseDSN treats the URI scheme as the only database selector. The optional
// timezone parameter sets the connection time zone; without it the server
// environment time zone is used.
// parseDSN reads the DSN URI. statementTimeoutMs bounds every statement of
// the connection; zero keeps the server default.
func parseDSN(raw string, statementTimeoutMs int) (parsedDSN, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" {
		return parsedDSN{}, configErr("dsn must be a URI using mysql://, postgres://, or sqlite://")
	}
	q := u.Query()
	out := parsedDSN{driver: strings.ToLower(u.Scheme), location: time.Local}
	zone := q.Get("timezone")
	if zone != "" {
		loc, err := loadZone(zone)
		if err != nil {
			return parsedDSN{}, configErr("dsn timezone %q: %v", zone, err)
		}
		out.location = loc
	}
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
		q.Del("timezone")
		if zone != "" {
			q.Set("time_zone", quoteText(zone))
		}
		q.Set("clientFoundRows", "true")
		if statementTimeoutMs > 0 {
			// MySQL bounds SELECT statements with max_execution_time.
			q.Set("max_execution_time", strconv.Itoa(statementTimeoutMs))
		}
		// Datetime cells arrive as UTC-located wall-clock values, which
		// localTime places in the connection time zone.
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
		out.native = raw
		changed := false
		if statementTimeoutMs > 0 {
			options := q.Get("options")
			if options != "" {
				options += " "
			}
			q.Set("options", options+"-c statement_timeout="+strconv.Itoa(statementTimeoutMs))
			changed = true
		}
		if posix := postgresZone(zone); posix != zone {
			q.Set("timezone", posix)
			changed = true
		}
		if changed {
			// PostgreSQL reads the option string literally, so a space is
			// percent-encoded instead of the form encoder's plus sign.
			u.RawQuery = strings.ReplaceAll(q.Encode(), "+", "%20")
			out.native = u.String()
		}
	case "sqlite":
		path := u.Path
		if !strings.HasPrefix(path, "/") {
			return parsedDSN{}, configErr("sqlite DSN must include an absolute database path")
		}
		// SQLite has no FOR UPDATE; the ORM row lock keeps transactions
		// deferred until a query requests a lock.
		if txlock := q.Get("_txlock"); txlock != "" && strings.ToLower(txlock) != "deferred" {
			return parsedDSN{}, configErr("sqlite DSN _txlock must be deferred")
		}
		q.Del("timezone")
		q.Set("_txlock", "deferred")
		if !strings.Contains(strings.Join(q["_pragma"], ","), "foreign_keys") {
			q.Add("_pragma", "foreign_keys(1)")
		}
		out.native = "file:" + path + "?" + q.Encode()
	default:
		return parsedDSN{}, configErr("unsupported DSN scheme %q; want mysql, postgres, or sqlite", u.Scheme)
	}
	return out, nil
}

// loadZone accepts an IANA name or a fixed offset such as +09:00.
func loadZone(zone string) (*time.Location, error) {
	if len(zone) == 6 && (zone[0] == '+' || zone[0] == '-') && zone[3] == ':' {
		t, err := time.Parse("-07:00", zone)
		if err != nil {
			return nil, err
		}
		_, offset := t.Zone()
		return time.FixedZone(zone, offset), nil
	}
	return time.LoadLocation(zone)
}

// postgresZone writes a fixed offset in the POSIX form PostgreSQL expects,
// where the sign after the name is inverted: +09:00 becomes <+09:00>-09:00.
func postgresZone(zone string) string {
	if len(zone) == 6 && (zone[0] == '+' || zone[0] == '-') && zone[3] == ':' {
		inverted := "-"
		if zone[0] == '-' {
			inverted = "+"
		}
		return "<" + zone + ">" + inverted + zone[1:]
	}
	return zone
}

// DriverFromDSN returns the database selected by a DSN URI.
func DriverFromDSN(raw string) (string, error) {
	parsed, err := parseDSN(raw, 0)
	return parsed.driver, err
}
