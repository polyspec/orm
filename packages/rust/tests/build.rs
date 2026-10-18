fn main() {
    polyspec_orm_build::Builder::set("../../../contracts/fixtures/bench/dbspec-set.json")
        .scan("src")
        .scan("tests/integration")
        .scan("../../../examples/complex/rust")
        .scan("../../../examples/thin-slice/rust")
        .generate();
    let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR is required; build the crate with cargo, which sets it for build scripts"));
    polyspec_orm_build::Builder::set("dbspec-set.json").scan("src/integration.rs").out_dir(out.join("nonnull")).generate();
    polyspec_orm_build::Builder::set("../../../contracts/fixtures/dbspec-set.json").scan("tests/decimal_physical.rs").out_dir(out.join("decimal")).generate();
    // The member document uses ext_core of core.dbs: its used tables are entities of the member set (ExtAudit among them), so the
    // member models carry the getter of the external relation as they carry any relation (integration.rs).
    polyspec_orm_build::Builder::set("external/dbspec-set.json").scan("src/integration.rs").out_dir(out.join("external")).generate();
    // The corpus catalog model of the markdown executor conformance (tests/markdown).
    polyspec_orm_build::Builder::set("../../../tests/markdown/corpus/dbspec/dbspec-set.json")
        .scan("tests/markdown_conformance.rs")
        .out_dir(out.join("markdown"))
        .generate();
}
