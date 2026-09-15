package orm

import (
	"net/url"
	"strings"
)

// parseDSN treats the URI scheme as the only public database selector and
// returns the dialect plus the native database/sql DSN.
func parseDSN(raw string) (string, string, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" {
		return "", "", configErr("dsn must be a URI using mysql://, postgres://, or sqlite://")
	}
	switch strings.ToLower(u.Scheme) {
	case "mysql":
		if u.Host == "" || strings.Trim(u.Path, "/") == "" {
			return "", "", configErr("mysql DSN must include host and database")
		}
		q := u.Query()
		network, address := "tcp", u.Host
		if socket := q.Get("socket"); socket != "" {
			network, address = "unix", socket
			q.Del("socket")
		}
		if !q.Has("clientFoundRows") || q.Get("clientFoundRows") != "true" {
			return "", "", configErr("mysql DSN must include clientFoundRows=true")
		}
		auth := ""
		if u.User != nil {
			password, hasPassword := u.User.Password()
			auth = u.User.Username()
			if hasPassword {
				auth += ":" + password
			}
		}
		native := auth + "@" + network + "(" + address + ")/" + strings.TrimPrefix(u.Path, "/")
		if encoded := q.Encode(); encoded != "" {
			native += "?" + encoded
		}
		return "mysql", native, nil
	case "postgres":
		if u.Host == "" || strings.Trim(u.Path, "/") == "" {
			return "", "", configErr("postgres DSN must include host and database")
		}
		return "postgres", raw, nil
	case "sqlite":
		path := u.Path
		if path == "" {
			return "", "", configErr("sqlite DSN must include an absolute database path")
		}
		if !strings.HasPrefix(path, "/") {
			return "", "", configErr("sqlite DSN path must be absolute")
		}
		q := u.Query()
		// SQLite has no FOR UPDATE syntax. The ORM implements the common
		// update/share lock contract with transaction-level serialization, so
		// every ORM transaction must begin with BEGIN IMMEDIATE.
		if txlock := q.Get("_txlock"); txlock != "" && strings.ToLower(txlock) != "immediate" {
			return "", "", configErr("sqlite DSN _txlock must be immediate for ORM lock semantics")
		}
		q.Set("_txlock", "immediate")
		native := "file:" + path + "?" + q.Encode()
		return "sqlite", native, nil
	default:
		return "", "", configErr("unsupported DSN scheme %q; want mysql, postgres, or sqlite", u.Scheme)
	}
}

// DriverFromDSN returns the database selected by a canonical DSN URI.
func DriverFromDSN(raw string) (string, error) {
	driver, _, err := parseDSN(raw)
	return driver, err
}

// NativeDSN returns the driver-specific DSN for internal adapter and benchmark
// code. Public application code should pass the canonical URI to Open.
func NativeDSN(raw string) (string, error) {
	_, native, err := parseDSN(raw)
	return native, err
}
