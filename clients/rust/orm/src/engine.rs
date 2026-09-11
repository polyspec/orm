//! The compiler boundary: ormengine.wasm loaded once per process through
//! wasmtime (decision R1). Compile is the cold path (once per query shape), so
//! a single instance behind a mutex is enough.

use std::sync::Mutex;

use crate::{Error, Result};

pub struct Engine {
    inner: Mutex<Inner>,
    pub schema_hash: String,
}

struct Inner {
    store: wasmtime::Store<wasmtime_wasi::p1::WasiP1Ctx>,
    memory: wasmtime::Memory,
    alloc: wasmtime::TypedFunc<u32, u32>,
    free: wasmtime::TypedFunc<u32, ()>,
    compile: wasmtime::TypedFunc<(u32, u32), u32>,
}

/// Where wasmtime may keep its compiled-module cache. Declared, not discovered.
pub struct EngineConfig<'a> {
    pub wasm: &'a [u8],
    pub schema_json: &'a [u8],
    pub cache_dir: Option<&'a std::path::Path>,
}

impl Engine {
    pub fn new(cfg: EngineConfig<'_>) -> Result<Engine> {
        let mut config = wasmtime::Config::new();
        if let Some(dir) = cfg.cache_dir {
            let mut cc = wasmtime::CacheConfig::new();
            cc.with_directory(dir);
            config.cache(Some(wasmtime::Cache::new(cc).map_err(|e| Error::Config(e.to_string()))?));
        }
        let engine = wasmtime::Engine::new(&config).map_err(|e| Error::Config(e.to_string()))?;
        let module = wasmtime::Module::new(&engine, cfg.wasm).map_err(|e| Error::Config(e.to_string()))?;
        let mut linker = wasmtime::Linker::new(&engine);
        wasmtime_wasi::p1::add_to_linker_sync(&mut linker, |t| t).map_err(|e| Error::Config(e.to_string()))?;
        let wasi = wasmtime_wasi::WasiCtxBuilder::new().build_p1();
        let mut store = wasmtime::Store::new(&engine, wasi);
        let instance = linker.instantiate(&mut store, &module).map_err(|e| Error::Config(e.to_string()))?;
        if let Ok(init) = instance.get_typed_func::<(), ()>(&mut store, "_initialize") {
            init.call(&mut store, ()).map_err(|e| Error::Config(e.to_string()))?;
        }
        let memory = instance.get_memory(&mut store, "memory").ok_or_else(|| Error::Config("no memory export".into()))?;
        let get = |store: &mut wasmtime::Store<_>, name: &str| -> Result<wasmtime::Func> {
            instance.get_func(&mut *store, name).ok_or_else(|| Error::Config(format!("missing export {name}")))
        };
        let alloc = get(&mut store, "orm_alloc")?.typed::<u32, u32>(&store).map_err(|e| Error::Config(e.to_string()))?;
        let free = get(&mut store, "orm_free")?.typed::<u32, ()>(&store).map_err(|e| Error::Config(e.to_string()))?;
        let load = get(&mut store, "orm_load")?.typed::<(u32, u32), u32>(&store).map_err(|e| Error::Config(e.to_string()))?;
        let compile = get(&mut store, "orm_compile")?.typed::<(u32, u32), u32>(&store).map_err(|e| Error::Config(e.to_string()))?;
        let mut inner = Inner { store, memory, alloc, free, compile };
        let (status, body) = inner.call(&load, cfg.schema_json)?;
        if status != 0 {
            return Err(engine_error(&body));
        }
        let hash = {
            let v: serde_json::Value = serde_json::from_slice(cfg.schema_json).map_err(|e| Error::Config(e.to_string()))?;
            v["schema_hash"].as_str().unwrap_or_default().to_owned()
        };
        Ok(Engine { inner: Mutex::new(inner), schema_hash: hash })
    }

    /// Compile IR JSON into plan JSON.
    pub fn compile(&self, ir_json: &[u8]) -> Result<Vec<u8>> {
        let mut inner = self.inner.lock().unwrap();
        let compile = inner.compile;
        let (status, body) = inner.call(&compile, ir_json)?;
        if status != 0 {
            return Err(engine_error(&body));
        }
        Ok(body)
    }
}

impl Inner {
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
        Err(_) => Error::Engine { code: "INTERNAL".into(), msg: String::from_utf8_lossy(body).into_owned() },
    }
}
