fn main() {
    orm_build::Builder::new("../../../schema/schema.json")
        .scan("src")
        .scan("../../../examples/complex/rust")
        .scan("../../../examples/thin-slice/rust")
        .generate();
    let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR is required"));
    orm_build::Builder::new("../orm/tests/testdata/audit_log_plain.json").scan("src/integration.rs").out_dir(out.join("nonnull")).generate();
}
