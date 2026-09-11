//! The compiler boundary: ormengine.wasm through wasmtime (decision R1).
//!
//! The instance lives on its own OS thread and is driven over a channel. This
//! keeps wasmtime-wasi's synchronous host shims (which `block_on` internally)
//! away from any async runtime the application uses. Compile is the cold path
//! (once per query shape), so a single worker is enough.

use std::sync::mpsc;
use std::sync::Mutex;

use crate::{Error, Result};

pub struct Engine {
    jobs: Mutex<mpsc::Sender<Job>>,
    pub schema_hash: String,
}

struct Job {
    input: Vec<u8>,
    reply: mpsc::Sender<Result<(u32, Vec<u8>)>>,
}

/// Where wasmtime may keep its compiled-module cache. Declared, not discovered.
pub struct EngineConfig<'a> {
    pub wasm: &'a [u8],
    pub schema_json: &'a [u8],
    pub cache_dir: Option<&'a std::path::Path>,
}

struct Inner {
    store: wasmtime::Store<wasmtime_wasi::p1::WasiP1Ctx>,
    memory: wasmtime::Memory,
    alloc: wasmtime::TypedFunc<u32, u32>,
    free: wasmtime::TypedFunc<u32, ()>,
    compile: wasmtime::TypedFunc<(u32, u32), u32>,
}

impl Engine {
    pub fn new(cfg: EngineConfig<'_>) -> Result<Engine> {
        let wasm = cfg.wasm.to_vec();
        let schema = cfg.schema_json.to_vec();
        let cache_dir = cfg.cache_dir.map(|p| p.to_path_buf());
        let (jobs_tx, jobs_rx) = mpsc::channel::<Job>();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<()>>();
        std::thread::Builder::new()
            .name("orm-engine".into())
            .spawn(move || {
                let mut inner = match Inner::start(&wasm, &schema, cache_dir.as_deref()) {
                    Ok(i) => {
                        let _ = ready_tx.send(Ok(()));
                        i
                    }
                    Err(e) => {
                        let _ = ready_tx.send(Err(e));
                        return;
                    }
                };
                for job in jobs_rx {
                    let compile = inner.compile.clone();
                    let _ = job.reply.send(inner.call(&compile, &job.input));
                }
            })
            .map_err(|e| Error::Config(e.to_string()))?;
        ready_rx.recv().map_err(|_| Error::Config("engine thread died during start".into()))??;
        let hash = {
            let v: serde_json::Value = serde_json::from_slice(cfg.schema_json).map_err(|e| Error::Config(e.to_string()))?;
            v["schema_hash"].as_str().unwrap_or_default().to_owned()
        };
        Ok(Engine { jobs: Mutex::new(jobs_tx), schema_hash: hash })
    }

    /// Compile IR JSON into plan JSON.
    pub fn compile(&self, ir_json: &[u8]) -> Result<Vec<u8>> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.jobs
            .lock()
            .unwrap()
            .send(Job { input: ir_json.to_vec(), reply: reply_tx })
            .map_err(|_| Error::Config("engine thread gone".into()))?;
        let (status, body) = reply_rx.recv().map_err(|_| Error::Config("engine thread gone".into()))??;
        if status != 0 {
            return Err(engine_error(&body));
        }
        Ok(body)
    }
}

impl Inner {
    fn start(wasm: &[u8], schema: &[u8], cache_dir: Option<&std::path::Path>) -> Result<Inner> {
        let cfg_err = |e: wasmtime::Error| Error::Config(e.to_string());
        let mut config = wasmtime::Config::new();
        if let Some(dir) = cache_dir {
            let mut cc = wasmtime::CacheConfig::new();
            cc.with_directory(dir);
            config.cache(Some(wasmtime::Cache::new(cc).map_err(cfg_err)?));
        }
        let engine = wasmtime::Engine::new(&config).map_err(cfg_err)?;
        let module = wasmtime::Module::new(&engine, wasm).map_err(cfg_err)?;
        let mut linker = wasmtime::Linker::new(&engine);
        wasmtime_wasi::p1::add_to_linker_sync(&mut linker, |t| t).map_err(cfg_err)?;
        let wasi = wasmtime_wasi::WasiCtxBuilder::new().build_p1();
        let mut store = wasmtime::Store::new(&engine, wasi);
        let instance = linker.instantiate(&mut store, &module).map_err(cfg_err)?;
        if let Ok(init) = instance.get_typed_func::<(), ()>(&mut store, "_initialize") {
            init.call(&mut store, ()).map_err(cfg_err)?;
        }
        let memory = instance.get_memory(&mut store, "memory").ok_or_else(|| Error::Config("no memory export".into()))?;
        let func = |store: &mut wasmtime::Store<_>, name: &str| -> Result<wasmtime::Func> {
            instance.get_func(&mut *store, name).ok_or_else(|| Error::Config(format!("missing export {name}")))
        };
        let alloc = func(&mut store, "orm_alloc")?.typed::<u32, u32>(&store).map_err(cfg_err)?;
        let free = func(&mut store, "orm_free")?.typed::<u32, ()>(&store).map_err(cfg_err)?;
        let load = func(&mut store, "orm_load")?.typed::<(u32, u32), u32>(&store).map_err(cfg_err)?;
        let compile = func(&mut store, "orm_compile")?.typed::<(u32, u32), u32>(&store).map_err(cfg_err)?;
        let mut inner = Inner { store, memory, alloc, free, compile };
        let (status, body) = inner.call(&load, schema)?;
        if status != 0 {
            return Err(engine_error(&body));
        }
        Ok(inner)
    }

    fn call(&mut self, f: &wasmtime::TypedFunc<(u32, u32), u32>, input: &[u8]) -> Result<(u32, Vec<u8>)> {
        let wrap = |e: wasmtime::Error| Error::Config(e.to_string());
        let p = self.alloc.call(&mut self.store, input.len() as u32).map_err(wrap)?;
        self.memory.write(&mut self.store, p as usize, input).map_err(|e| Error::Config(e.to_string()))?;
        let rp = f.call(&mut self.store, (p, input.len() as u32)).map_err(wrap)?;
        let mut hdr = [0u8; 8];
        self.memory.read(&self.store, rp as usize, &mut hdr).map_err(|e| Error::Config(e.to_string()))?;
        let status = u32::from_le_bytes(hdr[0..4].try_into().unwrap());
        let len = u32::from_le_bytes(hdr[4..8].try_into().unwrap()) as usize;
        let mut out = vec![0u8; len];
        self.memory.read(&self.store, rp as usize + 8, &mut out).map_err(|e| Error::Config(e.to_string()))?;
        self.free.call(&mut self.store, p).map_err(wrap)?;
        self.free.call(&mut self.store, rp).map_err(wrap)?;
        Ok((status, out))
    }
}

fn engine_error(body: &[u8]) -> Error {
    #[derive(serde::Deserialize)]
    struct Env {
        error: Inner2,
    }
    #[derive(serde::Deserialize)]
    struct Inner2 {
        code: String,
        msg: String,
    }
    match serde_json::from_slice::<Env>(body) {
        Ok(e) => Error::Engine { code: e.error.code, msg: e.error.msg },
        Err(_) => Error::internal(String::from_utf8_lossy(body).into_owned()),
    }
}
