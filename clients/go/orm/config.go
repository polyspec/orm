package orm

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
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
	Driver             string `toml:"driver"` // mysql (default) | postgres | sqlite — also the engine dialect
	DSN                string `toml:"dsn"`
	User               string `toml:"user"`
	Password           string `toml:"password"`
	Pool               int    `toml:"pool"`
	PlanCacheSize      int    `toml:"plan_cache_size"`
	StatementCacheSize int    `toml:"statement_cache_size"`
}

// SecretsConfig names the AES and blind-index keys: literally or by environment variable.
type SecretsConfig struct {
	AES           string            `toml:"aes"`
	AESEnv        string            `toml:"aes_env"`
	BlindIndex    string            `toml:"blind_index"`
	BlindIndexEnv string            `toml:"blind_index_env"`
	AESKeys       map[string]string `toml:"aes_keys"`
	AESVersion    int32             `toml:"aes_version"`
}

// EngineConfig is the Rust client's wasm engine; the Go client only validates the paths.
type EngineConfig struct {
	Wasm     string `toml:"wasm"`
	CacheDir string `toml:"cache_dir"`
}

// OrmdConfig declares the optional Connect compiler endpoint used by clients that
// compile through the shared compiler service.
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
	if fc.DB.PlanCacheSize < 0 || fc.DB.StatementCacheSize < 0 {
		return nil, configErr("%s: db cache sizes must not be negative", path)
	}
	if fc.Secrets.AES != "" && fc.Secrets.AESEnv != "" {
		return nil, configErr("%s: secrets.aes and secrets.aes_env are exclusive", path)
	}
	if fc.Secrets.BlindIndex != "" && fc.Secrets.BlindIndexEnv != "" {
		return nil, configErr("%s: secrets.blind_index and secrets.blind_index_env are exclusive", path)
	}
	if len(fc.Secrets.AESKeys) > 0 && (fc.Secrets.AES != "" || fc.Secrets.AESEnv != "") {
		return nil, configErr("%s: secrets.aes_keys is exclusive with secrets.aes and secrets.aes_env", path)
	}
	if len(fc.Secrets.AESKeys) > 0 {
		keys, err := fc.AESKeyring()
		if err != nil {
			return nil, configErr("%s: %v", path, err)
		}
		_ = keys
	} else if fc.Secrets.AESVersion != 0 && fc.Secrets.AESVersion != 1 {
		return nil, configErr("%s: secrets.aes_version requires secrets.aes_keys", path)
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

// BlindIndexKey resolves the stable HMAC key independently from AES rotation.
func (fc *FileConfig) BlindIndexKey() (string, error) {
	if fc.Secrets.BlindIndexEnv == "" {
		return fc.Secrets.BlindIndex, nil
	}
	v := os.Getenv(fc.Secrets.BlindIndexEnv)
	if v == "" {
		return "", configErr("secrets.blind_index_env: %s is not set", fc.Secrets.BlindIndexEnv)
	}
	return v, nil
}

// AESKey resolves [secrets]: the literal key, or the named environment
// variable's value (CONFIG when that variable is unset or empty).
func (fc *FileConfig) AESKey() (string, error) {
	if len(fc.Secrets.AESKeys) > 0 {
		keyring, err := fc.AESKeyring()
		if err != nil {
			return "", err
		}
		return keyring.keys[keyring.current], nil
	}
	if fc.Secrets.AESEnv == "" {
		return fc.Secrets.AES, nil
	}
	v := os.Getenv(fc.Secrets.AESEnv)
	if v == "" {
		return "", configErr("secrets.aes_env: %s is not set", fc.Secrets.AESEnv)
	}
	return v, nil
}

// AESKeyring returns the declared version map. Single-key settings create version 1.
// use version 1.
func (fc *FileConfig) AESKeyring() (AESKeyring, error) {
	if len(fc.Secrets.AESKeys) == 0 {
		key, err := fc.AESKey()
		if err != nil {
			return AESKeyring{}, err
		}
		if key == "" {
			return AESKeyring{}, configErr("no AES key is declared")
		}
		return NewAESKeyring(map[int32]string{1: key}, 1)
	}
	keys := make(map[int32]string, len(fc.Secrets.AESKeys))
	for text, key := range fc.Secrets.AESKeys {
		version, err := strconv.ParseInt(text, 10, 32)
		if err != nil || version < 1 {
			return AESKeyring{}, configErr("secrets.aes_keys.%s is invalid", text)
		}
		keys[int32(version)] = key
	}
	current := fc.Secrets.AESVersion
	if current == 0 {
		return AESKeyring{}, configErr("secrets.aes_version is required with secrets.aes_keys")
	}
	return NewAESKeyring(keys, current)
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

func hasBlindIndex(m *schema.Manifest) bool {
	for _, e := range m.Entities {
		for _, c := range e.Columns {
			if c.BlindIndex != "" {
				return true
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

// OpenConfigContext loads orm.toml and uses the declared compiler implementation.
// Without an endpoint, Go uses its native in-process compiler.
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
	blindKey, err := fc.BlindIndexKey()
	if err != nil {
		return nil, err
	}
	if blindKey == "" && hasBlindIndex(eng.M) {
		return nil, configErr("the schema has blind indexes but [secrets] declares neither blind_index nor blind_index_env")
	}
	dsn := fc.DB.DSN
	if driver == "mysql" {
		if dsn, err = mysqlDSN(&fc.DB); err != nil {
			return nil, err
		}
	} else if fc.DB.User != "" {
		return nil, configErr("[db].user/password apply to mysql DSNs only; put the user in the %s URL", driver)
	}
	version := fc.Secrets.AESVersion
	if version == 0 {
		version = 1
	}
	keyring, err := fc.AESKeyring()
	if err != nil {
		return nil, err
	}
	keys := make(map[int32]string, len(keyring.keys))
	for v, k := range keyring.keys {
		keys[v] = k
	}
	cfg := Config{AESKey: key, BlindIndexKey: blindKey, AESVersion: version, AESKeys: keys, PlanCacheSize: fc.DB.PlanCacheSize, StatementCacheSize: fc.DB.StatementCacheSize}
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
