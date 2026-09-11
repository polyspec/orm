//! `orm.toml` (docs/config.md): one declared configuration, loaded by `Db::from_config`.
//! Every path is absolute, exists and is not a symlink; anything else is `CONFIG`.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Deserialize;

use crate::db::{Config, Db, OnQuery};
use crate::engine::{Engine, EngineConfig};
use crate::value::Param;
use crate::{Error, Result};

#[derive(Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields)]
pub struct OrmConfig {
    /// The manifest the client was generated from (its hash is checked once by `gen::init`).
    pub schema: PathBuf,
    pub db: DbSection,
    #[serde(default)]
    pub secrets: SecretsSection,
    /// The wasm engine (Rust only).
    pub engine: EngineSection,
    /// The PHP compile daemon: read by the PHP client, accepted here.
    #[serde(default)]
    pub ormd: Option<OrmdSection>,
    #[serde(default)]
    pub debug: DebugSection,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields)]
pub struct DbSection {
    /// sqlx URL: `mysql://root@localhost/orm_bench?socket=/tmp/mysql.sock`.
    pub dsn: String,
    /// Applied only when the URL carries no user; a different user in both is `CONFIG`.
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default = "default_pool")]
    pub pool: u32,
}

fn default_pool() -> u32 {
    8
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(deny_unknown_fields)]
pub struct SecretsSection {
    #[serde(default)]
    pub aes: Option<String>,
    /// Name of the environment variable holding the AES key.
    #[serde(default)]
    pub aes_env: Option<String>,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields)]
pub struct EngineSection {
    pub wasm: PathBuf,
    #[serde(default)]
    pub cache_dir: Option<PathBuf>,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields)]
pub struct OrmdSection {
    pub socket: PathBuf,
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(deny_unknown_fields)]
pub struct DebugSection {
    /// Log every statement to stderr: sql, binds (secrets masked), duration, plan id.
    #[serde(default)]
    pub on_query: bool,
}

fn cfg_err(what: impl std::fmt::Display) -> Error {
    Error::Config(what.to_string())
}

/// A declared path: absolute, existing, not a symlink (checked on the path itself, so a
/// symlinked file or directory is refused even though it resolves).
pub fn check_path(key: &str, p: &Path) -> Result<()> {
    if !p.is_absolute() {
        return Err(cfg_err(format!("{key}: {} is not absolute", p.display())));
    }
    let meta = std::fs::symlink_metadata(p).map_err(|e| cfg_err(format!("{key}: {}: {e}", p.display())))?;
    if meta.file_type().is_symlink() {
        return Err(cfg_err(format!("{key}: {} is a symlink", p.display())));
    }
    Ok(())
}

/// The user of a sqlx URL, when its authority carries one (`mysql://user[:pw]@host…`).
fn url_user(dsn: &str) -> Option<&str> {
    let rest = dsn.split_once("://")?.1;
    let authority = rest.split(['/', '?']).next()?;
    let (userinfo, _) = authority.rsplit_once('@')?;
    let user = userinfo.split(':').next()?;
    (!user.is_empty()).then_some(user)
}

impl OrmConfig {
    /// Parses and validates `orm.toml` at `path`: paths, `[db]` user rule, `[secrets]` exclusivity.
    pub fn load(path: impl AsRef<Path>) -> Result<OrmConfig> {
        let path = path.as_ref();
        let text = std::fs::read_to_string(path).map_err(|e| cfg_err(format!("{}: {e}", path.display())))?;
        let cfg: OrmConfig = toml::from_str(&text).map_err(|e| cfg_err(format!("{}: {e}", path.display())))?;
        check_path("schema", &cfg.schema)?;
        check_path("engine.wasm", &cfg.engine.wasm)?;
        if let Some(dir) = &cfg.engine.cache_dir {
            check_path("engine.cache_dir", dir)?;
        }
        if let Some(o) = &cfg.ormd {
            if !o.socket.is_absolute() {
                return Err(cfg_err(format!("ormd.socket: {} is not absolute", o.socket.display())));
            }
        }
        if cfg.db.dsn.is_empty() {
            return Err(cfg_err("db.dsn is empty"));
        }
        if let (Some(u), Some(cu)) = (url_user(&cfg.db.dsn), cfg.db.user.as_deref()) {
            if u != cu {
                return Err(cfg_err(format!("db.user {cu:?} conflicts with the user {u:?} in db.dsn")));
            }
        }
        if cfg.secrets.aes.is_some() && cfg.secrets.aes_env.is_some() {
            return Err(cfg_err("secrets: declare aes or aes_env, not both"));
        }
        Ok(cfg)
    }

    /// The AES key: `[secrets].aes`, or the value of the `[secrets].aes_env` variable;
    /// empty when neither is declared (a statement with a secret slot then fails with CONFIG).
    pub fn aes_key(&self) -> Result<String> {
        match (&self.secrets.aes, &self.secrets.aes_env) {
            (Some(k), _) => Ok(k.clone()),
            (None, Some(var)) => std::env::var(var).map_err(|_| cfg_err(format!("secrets.aes_env: {var} is not set"))),
            (None, None) => Ok(String::new()),
        }
    }

    /// The sqlx connect options: the URL, with `[db].user`/`password` applied when the URL has no user.
    pub fn connect_options(&self) -> Result<sqlx::mysql::MySqlConnectOptions> {
        let mut opts: sqlx::mysql::MySqlConnectOptions = self.db.dsn.parse().map_err(|e| cfg_err(format!("db.dsn: {e}")))?;
        if url_user(&self.db.dsn).is_none() {
            if let Some(u) = &self.db.user {
                opts = opts.username(u);
            }
            if let Some(p) = &self.db.password {
                opts = opts.password(p);
            }
        }
        Ok(opts)
    }

    /// Whether the manifest declares a column with the `aes` style (so a secret must be configured).
    fn schema_has_aes(schema_json: &[u8]) -> bool {
        let Ok(v) = serde_json::from_slice::<serde_json::Value>(schema_json) else { return false };
        let Some(entities) = v["entities"].as_object() else { return false };
        entities.values().any(|e| {
            e["columns"].as_array().map(|cols| cols.iter().any(|c| c["styles"].as_array().map(|s| s.iter().any(|x| x == "aes")).unwrap_or(false))).unwrap_or(false)
        })
    }
}

/// The `[debug].on_query = true` hook: one line per statement on stderr.
fn stderr_logger() -> OnQuery {
    Box::new(|sql: &str, binds: &[Param], d: std::time::Duration, plan_id: u64, err: Option<&Error>| {
        let binds: Vec<String> = binds.iter().map(|b| format!("{b:?}")).collect();
        match err {
            Some(e) => eprintln!("orm {plan_id:016x} {:?} {sql} [{}] error={e}", d, binds.join(", ")),
            None => eprintln!("orm {plan_id:016x} {:?} {sql} [{}]", d, binds.join(", ")),
        }
    })
}

impl Db {
    /// Loads `orm.toml` (docs/config.md), starts the wasm engine from `[engine].wasm` with the
    /// manifest at `schema`, and connects `[db]`. Bind the generated crate afterwards with
    /// `gen::init(db.engine.clone())?`, which performs the schema_hash check.
    pub async fn from_config(path: impl AsRef<Path>) -> Result<Db> {
        let cfg = OrmConfig::load(path)?;
        let wasm = std::fs::read(&cfg.engine.wasm).map_err(|e| cfg_err(format!("engine.wasm: {e}")))?;
        let schema = std::fs::read(&cfg.schema).map_err(|e| cfg_err(format!("schema: {e}")))?;
        let aes_key = cfg.aes_key()?;
        if aes_key.is_empty() && OrmConfig::schema_has_aes(&schema) {
            return Err(cfg_err("secrets: the schema has aes columns but neither aes nor aes_env is declared"));
        }
        let engine = Arc::new(Engine::new(EngineConfig { wasm: &wasm, schema_json: &schema, cache_dir: cfg.engine.cache_dir.as_deref() })?);
        let on_query = cfg.debug.on_query.then(stderr_logger);
        Db::connect(cfg.connect_options()?, cfg.db.pool, engine, Config { aes_key, on_query }).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, name: &str, body: &str) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, body).unwrap();
        p
    }

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("orm-config-{}-{}", std::process::id(), rand::random::<u32>()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn url_user_parsing() {
        assert_eq!(url_user("mysql://root@localhost/orm_bench?socket=/tmp/mysql.sock"), Some("root"));
        assert_eq!(url_user("mysql://app:p%40ss@127.0.0.1:3306/db"), Some("app"));
        assert_eq!(url_user("mysql://localhost/db?user=x"), None);
        assert_eq!(url_user("mysql://127.0.0.1:3306/db"), None);
    }

    #[test]
    fn relative_and_symlinked_paths_are_config_errors() {
        let d = tmp();
        let wasm = write(&d, "engine.wasm", "");
        let schema = write(&d, "schema.json", "{}");
        let rel = write(&d, "rel.toml", &format!("schema = \"schema/schema.json\"\n[db]\ndsn = \"mysql://root@localhost/x\"\n[engine]\nwasm = {:?}\n", wasm));
        let e = OrmConfig::load(&rel).unwrap_err();
        assert_eq!(e.code(), crate::codes::CONFIG);
        assert!(e.to_string().contains("not absolute"), "{e}");

        let missing = write(&d, "missing.toml", &format!("schema = {:?}\n[db]\ndsn = \"mysql://root@localhost/x\"\n[engine]\nwasm = {:?}\n", d.join("nope.json"), wasm));
        assert_eq!(OrmConfig::load(&missing).unwrap_err().code(), crate::codes::CONFIG);

        #[cfg(unix)]
        {
            let link = d.join("link.wasm");
            std::os::unix::fs::symlink(&wasm, &link).unwrap();
            let sym = write(&d, "sym.toml", &format!("schema = {:?}\n[db]\ndsn = \"mysql://root@localhost/x\"\n[engine]\nwasm = {:?}\n", schema, link));
            let e = OrmConfig::load(&sym).unwrap_err();
            assert!(e.to_string().contains("symlink"), "{e}");
        }

        let ok = write(&d, "ok.toml", &format!("schema = {:?}\n[db]\ndsn = \"mysql://localhost/x\"\nuser = \"app\"\npassword = \"pw\"\npool = 2\n[secrets]\naes = \"k\"\n[engine]\nwasm = {:?}\n[debug]\non_query = true\n", schema, wasm));
        let c = OrmConfig::load(&ok).unwrap();
        assert_eq!(c.db.pool, 2);
        assert_eq!(c.aes_key().unwrap(), "k");
        assert_eq!(c.connect_options().unwrap().get_username(), "app");

        let conflict = write(&d, "conflict.toml", &format!("schema = {:?}\n[db]\ndsn = \"mysql://root@localhost/x\"\nuser = \"app\"\n[engine]\nwasm = {:?}\n", schema, wasm));
        assert!(OrmConfig::load(&conflict).unwrap_err().to_string().contains("conflicts"));

        let both = write(&d, "both.toml", &format!("schema = {:?}\n[db]\ndsn = \"mysql://root@localhost/x\"\n[secrets]\naes = \"k\"\naes_env = \"K\"\n[engine]\nwasm = {:?}\n", schema, wasm));
        assert!(OrmConfig::load(&both).unwrap_err().to_string().contains("not both"));

        let unknown = write(&d, "unknown.toml", &format!("schema = {:?}\n[db]\ndsn = \"mysql://root@localhost/x\"\n[engine]\nwasm = {:?}\nwat = 1\n", schema, wasm));
        assert_eq!(OrmConfig::load(&unknown).unwrap_err().code(), crate::codes::CONFIG);
        let _ = std::fs::remove_dir_all(&d);
    }
}
