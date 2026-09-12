package orm

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"

	"github.com/BurntSushi/toml"
	"github.com/go-sql-driver/mysql"

	"github.com/polyspec/orm/engine"
	"github.com/polyspec/orm/engine/ir"
	"github.com/polyspec/orm/engine/schema"
)

// FileConfig is orm.toml (docs/config.md): one declared configuration shared
// by the four clients. Every path is absolute and must exist; nothing is
// discovered and nothing falls back.
type FileConfig struct {
	Schema  string        `toml:"schema"`
	DB      DBConfig      `toml:"db"`
	Secrets SecretsConfig `toml:"secrets"`
	Engine  EngineConfig  `toml:"engine"`
	Ormd    OrmdConfig    `toml:"ormd"`
	Debug   DebugConfig   `toml:"debug"`
}

type DBConfig struct {
	Driver   string `toml:"driver"` // mysql (default) | postgres | sqlite — also the engine dialect
	DSN      string `toml:"dsn"`
	User     string `toml:"user"`
	Password string `toml:"password"`
	Pool     int    `toml:"pool"`
}

// SecretsConfig names the AES key: literally (aes) or by environment variable (aes_env).
type SecretsConfig struct {
	AES    string `toml:"aes"`
	AESEnv string `toml:"aes_env"`
}

// EngineConfig is the Rust client's wasm engine; the Go client only validates the paths.
type EngineConfig struct {
	Wasm     string `toml:"wasm"`
	CacheDir string `toml:"cache_dir"`
}

// OrmdConfig is the PHP client's compile daemon; the Go client only validates the path.
type OrmdConfig struct {
	Endpoint  string `toml:"endpoint"`
	TimeoutMS int    `toml:"timeout_ms"`
	Socket    string `toml:"socket"`
}

type DebugConfig struct {
	OnQuery bool `toml:"on_query"`
}

func configErr(format string, a ...any) error {
	return &ir.Error{Code: CodeConfig, Msg: fmt.Sprintf(format, a...)}
}

// declaredPath checks one configured path: absolute, existing, not a symlink.
func declaredPath(key, p string) error {
	if !filepath.IsAbs(p) {
		return configErr("%s: %q is not an absolute path", key, p)
	}
	fi, err := os.Lstat(p)
	if err != nil {
		return configErr("%s: %v", key, err)
	}
	if fi.Mode()&os.ModeSymlink != 0 {
		return configErr("%s: %q is a symlink", key, p)
	}
	return nil
}

// LoadConfig parses and validates orm.toml without connecting: unknown keys,
// relative or missing paths, symlinks, and an undeclared secret are CONFIG errors.
func LoadConfig(path string) (*FileConfig, error) {
	if !filepath.IsAbs(path) {
		return nil, configErr("config path %q is not absolute", path)
	}
	var fc FileConfig
	md, err := toml.DecodeFile(path, &fc)
	if err != nil {
		return nil, configErr("%s: %v", path, err)
	}
	if undecoded := md.Undecoded(); len(undecoded) > 0 {
		return nil, configErr("%s: unknown key %s", path, undecoded[0])
	}
	if fc.Schema == "" {
		return nil, configErr("%s: schema is required", path)
	}
	if err := declaredPath("schema", fc.Schema); err != nil {
		return nil, err
	}
	if fc.DB.DSN == "" {
		return nil, configErr("%s: db.dsn is required", path)
	}
	if fc.DB.Pool < 0 {
		return nil, configErr("%s: db.pool must not be negative", path)
	}
	if fc.Secrets.AES != "" && fc.Secrets.AESEnv != "" {
		return nil, configErr("%s: secrets.aes and secrets.aes_env are exclusive", path)
	}
	for key, p := range map[string]string{"engine.wasm": fc.Engine.Wasm, "engine.cache_dir": fc.Engine.CacheDir, "ormd.socket": fc.Ormd.Socket} {
		if p == "" {
			continue
		}
		if err := declaredPath(key, p); err != nil {
			return nil, err
		}
	}
	if fc.Ormd.TimeoutMS < 0 {
		return nil, configErr("%s: ormd.timeout_ms must not be negative", path)
	}
	return &fc, nil
}

// AESKey resolves [secrets]: the literal key, or the named environment
// variable's value (CONFIG when that variable is unset or empty).
func (fc *FileConfig) AESKey() (string, error) {
	if fc.Secrets.AESEnv == "" {
		return fc.Secrets.AES, nil
	}
	v := os.Getenv(fc.Secrets.AESEnv)
	if v == "" {
		return "", configErr("secrets.aes_env: %s is not set", fc.Secrets.AESEnv)
	}
	return v, nil
}

// hasAES reports whether any column of the manifest carries the aes style.
func hasAES(m *schema.Manifest) bool {
	for _, e := range m.Entities {
		for _, c := range e.Columns {
			for _, s := range c.Styles {
				if s == "aes" {
					return true
				}
			}
		}
	}
	return false
}

// mysqlDSN applies [db].user/password to the DSN when the DSN itself carries
// no user; a DSN that names a different user than [db].user is a CONFIG error.
func mysqlDSN(db *DBConfig) (string, error) {
	cfg, err := mysql.ParseDSN(db.DSN)
	if err != nil {
		return "", configErr("db.dsn: %v", err)
	}
	switch {
	case cfg.User == "" && db.User != "":
		cfg.User, cfg.Passwd = db.User, db.Password
	case db.User != "" && cfg.User != db.User:
		return "", configErr("db.dsn names user %q but db.user is %q", cfg.User, db.User)
	}
	if !cfg.ClientFoundRows {
		return "", configErr("db.dsn must include clientFoundRows=true")
	}
	return cfg.FormatDSN(), nil
}

// OpenConfig loads orm.toml, the schema it names and the engine for it, and
// connects. The generated package's Init(db.Eng) then performs the one
// schema_hash check.
func OpenConfig(path string) (*DB, error) {
	return OpenConfigContext(context.Background(), path)
}

// OpenConfigContext loads orm.toml and uses the declared Connect compiler.
// A missing endpoint keeps the pre-Connect in-process behavior for compatibility.
func OpenConfigContext(ctx context.Context, path string) (*DB, error) {
	fc, err := LoadConfig(path)
	if err != nil {
		return nil, err
	}
	js, err := os.ReadFile(fc.Schema)
	if err != nil {
		return nil, configErr("schema: %v", err)
	}
	driver := fc.DB.Driver
	if driver == "" {
		driver = "mysql"
	}
	eng, err := engine.LoadJSON(js, driver)
	if err != nil {
		return nil, err
	}
	key, err := fc.AESKey()
	if err != nil {
		return nil, err
	}
	if key == "" && hasAES(eng.M) {
		return nil, configErr("the schema has aes columns but [secrets] declares neither aes nor aes_env")
	}
	dsn := fc.DB.DSN
	if driver == "mysql" {
		if dsn, err = mysqlDSN(&fc.DB); err != nil {
			return nil, err
		}
	} else if fc.DB.User != "" {
		return nil, configErr("[db].user/password apply to mysql DSNs only; put the user in the %s URL", driver)
	}
	cfg := Config{AESKey: key}
	if fc.Debug.OnQuery {
		cfg.OnQuery = LogQuery
	}
	var db *DB
	if fc.Ormd.Endpoint == "" {
		db, err = Open(driver, dsn, eng, cfg)
	} else {
		timeout := fc.Ormd.TimeoutMS
		if timeout == 0 {
			timeout = 5000
		}
		compiler, compilerErr := NewConnectCompiler(fc.Ormd.Endpoint, time.Duration(timeout)*time.Millisecond)
		if compilerErr != nil {
			return nil, compilerErr
		}
		db, err = OpenWithCompiler(ctx, driver, dsn, eng, compiler, cfg)
	}
	if err != nil {
		return nil, err
	}
	if fc.DB.Pool > 0 {
		db.SQL.SetMaxOpenConns(fc.DB.Pool)
	}
	return db, nil
}

// LogQuery is the [debug].on_query hook: one line per statement on the
// standard logger (sql, binds with secrets masked, duration, plan id).
func LogQuery(e Event) {
	log.Printf("orm: plan=%s %s %v %s err=%v", e.PlanID, e.SQL, e.Args, e.Duration, e.Err)
}

// driverOf is [db].driver with the mysql default; the engine dialect follows it.
func driverOf(db *DBConfig) string {
	if db.Driver == "" {
		return "mysql"
	}
	return db.Driver
}
