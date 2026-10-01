fn main() {
    orm_build::Builder::new(["../../../schema/bench.dbspec"])
        .scan("src")
        .scan("../../../examples/complex/rust")
        .scan("../../../examples/thin-slice/rust")
        .generate();
    let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR is required"));
    orm_build::Builder::new(["nonnull.dbspec"]).scan("src/integration.rs").out_dir(out.join("nonnull")).generate();
    orm_build::Builder::new(["../../../contracts/fixtures/decimal_schema.dbspec"]).scan("src/decimal_physical.rs").out_dir(out.join("decimal")).generate();
}
