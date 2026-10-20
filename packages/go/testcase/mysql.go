package testcase

import (
	"net/url"
	"strings"

	"github.com/go-sql-driver/mysql"
)

// MySQLConfig returns the go-sql-driver configuration of the MySQL client DSN
// uri: the user, the password, and the database of its path, over TCP to its
// host, or over the unix socket named by its socket query parameter.
func MySQLConfig(uri string) (*mysql.Config, error) {
	u, err := url.Parse(uri)
	if err != nil {
		return nil, err
	}
	cfg := mysql.NewConfig()
	cfg.User = u.User.Username()
	cfg.Passwd, _ = u.User.Password()
	cfg.DBName = strings.TrimPrefix(u.Path, "/")
	cfg.Net, cfg.Addr = "tcp", u.Host
	if socket := u.Query().Get("socket"); socket != "" {
		cfg.Net, cfg.Addr = "unix", socket
	}
	return cfg, nil
}
