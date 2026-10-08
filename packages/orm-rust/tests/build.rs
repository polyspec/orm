fn main() {
    polyspec_orm_build::Builder::new(["../../../schema/bench.dbs"])
        .scan("src")
        .scan("../../../examples/complex/rust")
        .scan("../../../examples/thin-slice/rust")
        .generate();
    let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR is required; build the crate with cargo, which sets it for build scripts"));
    polyspec_orm_build::Builder::new(["nonnull.dbs"]).scan("src/integration.rs").out_dir(out.join("nonnull")).generate();
    polyspec_orm_build::Builder::new(["../../../contracts/fixtures/decimal_schema.dbs"])
        .scan("src/decimal_physical.rs")
        .out_dir(out.join("decimal"))
        .generate();
}
