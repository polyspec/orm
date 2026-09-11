//! S0: cost of crossing into the engine from Rust.
//!   libloading: dlopen libormengine.dylib, call orm_compile
//!   wasmtime:   instantiate ormengine.wasm (wasip1 reactor), call orm_compile
//! Usage: boundary <dylib> <wasm> <schema.json> [iters]

use std::time::Instant;

const IR_LIST_T: &str = r#"{"ir_version":1,"schema_hash":"HASH","kind":"all","entity":"battle",
 "where":{"items":[
   {"pred":{"column":"service_seq","op":"eq","value":5}},
   {"pred":{"conn":"and","column":"is_close","op":"eq","value":0}},
   {"group":{"conn":"and","items":[
     {"pred":{"column":"is_display","op":"eq","value":1}},
     {"group":{"conn":"or","items":[
       {"pred":{"column":"is_display","op":"eq","value":2}},
       {"pred":{"conn":"and","column":"display_start_dt","op":"lt","value":"2026-09-11 00:00:00"}},
       {"pred":{"conn":"and","column":"display_end_dt","op":"gt","value":"2026-09-11 00:00:00"}}]}}]}},
   {"pred":{"conn":"and","column":"seq","op":"in","values":[1,2,3]}}]},
 "order":[{"column":"seq","desc":true}],"limit":{"offset":0,"count":100}}"#;

const IR_PK_T: &str = r#"{"ir_version":1,"schema_hash":"HASH","kind":"one","entity":"battle",
 "where":{"items":[{"pred":{"column":"seq","op":"eq","value":42}}]}}"#;

fn stats(name: &str, mut samples: Vec<u64>) {
    samples.sort_unstable();
    let n = samples.len();
    let p = |q: f64| samples[((n as f64 - 1.0) * q) as usize];
    let mean = samples.iter().sum::<u64>() as f64 / n as f64;
    println!(
        "{:<28} n={:<7} mean={:>8.0}ns p50={:>7}ns p90={:>7}ns p99={:>7}ns max={:>8}ns",
        name, n, mean, p(0.5), p(0.9), p(0.99), samples[n - 1]
    );
}

// ---------- libloading ----------
type CompileFn = unsafe extern "C" fn(*const u8, usize, *mut *mut u8, *mut usize) -> i32;
type LoadFn = unsafe extern "C" fn(*const u8, usize, *const std::os::raw::c_char, *mut *mut u8, *mut usize) -> i32;
type FreeFn = unsafe extern "C" fn(*mut u8);

struct Ffi {
    _lib: libloading::Library,
    compile: CompileFn,
    free: FreeFn,
}

impl Ffi {
    fn load(path: &str, schema: &[u8]) -> Ffi {
        unsafe {
            let lib = libloading::Library::new(path).expect("dlopen");
            let load: LoadFn = *lib.get(b"orm_load\0").expect("orm_load");
            let compile: CompileFn = *lib.get(b"orm_compile\0").expect("orm_compile");
            let free: FreeFn = *lib.get(b"orm_free\0").expect("orm_free");
            let dialect = std::ffi::CString::new("mysql").unwrap();
            let mut err: *mut u8 = std::ptr::null_mut();
            let mut err_len: usize = 0;
            let rc = load(schema.as_ptr(), schema.len(), dialect.as_ptr(), &mut err, &mut err_len);
            assert_eq!(rc, 0, "orm_load failed: {}", String::from_utf8_lossy(std::slice::from_raw_parts(err, err_len)));
            Ffi { compile, free, _lib: lib }
        }
    }
    fn compile(&self, ir: &[u8]) -> Result<Vec<u8>, Vec<u8>> {
        let mut out: *mut u8 = std::ptr::null_mut();
        let mut out_len: usize = 0;
        unsafe {
            let rc = (self.compile)(ir.as_ptr(), ir.len(), &mut out, &mut out_len);
            let v = std::slice::from_raw_parts(out, out_len).to_vec();
            (self.free)(out);
            if rc == 0 { Ok(v) } else { Err(v) }
        }
    }
}

// ---------- wasmtime ----------
struct Wasm {
    store: wasmtime::Store<wasmtime_wasi::p1::WasiP1Ctx>,
    memory: wasmtime::Memory,
    alloc: wasmtime::TypedFunc<u32, u32>,
    free: wasmtime::TypedFunc<u32, ()>,
    compile: wasmtime::TypedFunc<(u32, u32), u32>,
}

impl Wasm {
    fn load(path: &str, schema: &[u8]) -> (Wasm, std::time::Duration, std::time::Duration) {
        let t0 = Instant::now();
        let mut config = wasmtime::Config::new();
        config.cache(Some(wasmtime::Cache::from_file(None).expect("cache config")));
        let engine = wasmtime::Engine::new(&config).expect("engine");
        let module = wasmtime::Module::from_file(&engine, path).expect("module");
        let t_compile = t0.elapsed();

        let t1 = Instant::now();
        let mut linker = wasmtime::Linker::new(&engine);
        wasmtime_wasi::p1::add_to_linker_sync(&mut linker, |t| t).expect("wasi");
        let wasi = wasmtime_wasi::WasiCtxBuilder::new().build_p1();
        let mut store = wasmtime::Store::new(&engine, wasi);
        let instance = linker.instantiate(&mut store, &module).expect("instantiate");
        // Reactor: run _initialize once.
        if let Some(init) = instance.get_typed_func::<(), ()>(&mut store, "_initialize").ok() {
            init.call(&mut store, ()).expect("_initialize");
        }
        let memory = instance.get_memory(&mut store, "memory").expect("memory");
        let alloc = instance.get_typed_func::<u32, u32>(&mut store, "orm_alloc").expect("orm_alloc");
        let free = instance.get_typed_func::<u32, ()>(&mut store, "orm_free").expect("orm_free");
        let compile = instance.get_typed_func::<(u32, u32), u32>(&mut store, "orm_compile").expect("orm_compile");
        let load = instance.get_typed_func::<(u32, u32), u32>(&mut store, "orm_load").expect("orm_load");
        let t_inst = t1.elapsed();
        let mut w = Wasm { store, memory, alloc, free, compile };
        // load schema
        let p = w.alloc.call(&mut w.store, schema.len() as u32).expect("alloc");
        w.memory.write(&mut w.store, p as usize, schema).expect("write");
        let rp = load.call(&mut w.store, (p, schema.len() as u32)).expect("load");
        let mut hdr = [0u8; 8];
        w.memory.read(&w.store, rp as usize, &mut hdr).expect("hdr");
        assert_eq!(u32::from_le_bytes(hdr[0..4].try_into().unwrap()), 0, "orm_load failed");
        w.free.call(&mut w.store, p).unwrap();
        w.free.call(&mut w.store, rp).unwrap();
        (w, t_compile, t_inst)
    }

    fn compile(&mut self, ir: &[u8]) -> Result<Vec<u8>, Vec<u8>> {
        let p = self.alloc.call(&mut self.store, ir.len() as u32).expect("alloc");
        self.memory.write(&mut self.store, p as usize, ir).expect("write");
        let rp = self.compile.call(&mut self.store, (p, ir.len() as u32)).expect("compile");
        let mut hdr = [0u8; 8];
        self.memory.read(&self.store, rp as usize, &mut hdr).expect("read hdr");
        let status = u32::from_le_bytes(hdr[0..4].try_into().unwrap());
        let len = u32::from_le_bytes(hdr[4..8].try_into().unwrap()) as usize;
        let mut out = vec![0u8; len];
        self.memory.read(&self.store, rp as usize + 8, &mut out).expect("read body");
        self.free.call(&mut self.store, p).expect("free req");
        self.free.call(&mut self.store, rp).expect("free resp");
        if status == 0 { Ok(out) } else { Err(out) }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let dylib = &args[1];
    let wasm = &args[2];
    let iters: usize = args.get(4).and_then(|s| s.parse().ok()).unwrap_or(20_000);
    let schema = std::fs::read(&args[3]).expect("schema.json");
    let hash = {
        let s = String::from_utf8_lossy(&schema);
        let i = s.find("\"schema_hash\": \"").expect("schema_hash") + 16;
        s[i..i + 16].to_string()
    };
    let ir_list = IR_LIST_T.replace("HASH", &hash);
    let ir_pk = IR_PK_T.replace("HASH", &hash);
    let (IR_LIST, IR_PK) = (ir_list.as_str(), ir_pk.as_str());

    println!("== libloading ==");
    let t = Instant::now();
    let ffi = Ffi::load(dylib, &schema);
    println!("dlopen+symbols: {:?}", t.elapsed());
    let plan = ffi.compile(IR_LIST.as_bytes()).expect("compile ok");
    println!("plan bytes: {} (list) / {} (pk)", plan.len(), ffi.compile(IR_PK.as_bytes()).unwrap().len());
    for (name, ir) in [("ffi compile list", IR_LIST), ("ffi compile pk", IR_PK)] {
        for _ in 0..2000 { ffi.compile(ir.as_bytes()).unwrap(); }
        let mut s = Vec::with_capacity(iters);
        for _ in 0..iters {
            let t = Instant::now();
            std::hint::black_box(ffi.compile(ir.as_bytes()).unwrap());
            s.push(t.elapsed().as_nanos() as u64);
        }
        stats(name, s);
    }
    // error path
    let err = ffi.compile(br#"{"ir_version":1,"schema_hash":"x","kind":"all","entity":"battle"}"#).unwrap_err();
    println!("ffi error path: {}", String::from_utf8_lossy(&err));

    println!("== wasmtime ==");
    let (mut w, t_compile, t_inst) = Wasm::load(wasm, &schema);
    println!("module compile(load, cached after first run): {:?}, instantiate+_initialize: {:?}", t_compile, t_inst);
    let plan_w = w.compile(IR_LIST.as_bytes()).expect("compile ok");
    assert_eq!(plan, plan_w, "wasm and ffi must produce identical plans");
    for (name, ir) in [("wasm compile list", IR_LIST), ("wasm compile pk", IR_PK)] {
        for _ in 0..2000 { w.compile(ir.as_bytes()).unwrap(); }
        let mut s = Vec::with_capacity(iters);
        for _ in 0..iters {
            let t = Instant::now();
            std::hint::black_box(w.compile(ir.as_bytes()).unwrap());
            s.push(t.elapsed().as_nanos() as u64);
        }
        stats(name, s);
    }
    // Fresh-instance cost (what a per-request PHP would pay) x5
    let mut s = Vec::new();
    for _ in 0..5 {
        let t = Instant::now();
        let (_w2, _, _) = Wasm::load(wasm, &schema);
        s.push(t.elapsed().as_nanos() as u64);
    }
    stats("wasm load+instantiate (x5)", s);
}
