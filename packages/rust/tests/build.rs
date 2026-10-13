fn main() {
    polyspec_orm_build::Builder::set("../../../schema/dbspec-set.json")
        .scan("src")
        .scan("../../../examples/complex/rust")
        .scan("../../../examples/thin-slice/rust")
        .generate();
    let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR is required; build the crate with cargo, which sets it for build scripts"));
    polyspec_orm_build::Builder::set("dbspec-set.json").scan("src/integration.rs").out_dir(out.join("nonnull")).generate();
    polyspec_orm_build::Builder::set("../../../contracts/fixtures/dbspec-set.json").scan("src/decimal_physical.rs").out_dir(out.join("decimal")).generate();
    // markdown executor conformance(tests/markdown)의 corpus catalog model이다.
    polyspec_orm_build::Builder::set("../../../tests/markdown/corpus/dbspec/dbspec-set.json")
        .scan("tests/markdown_conformance.rs")
        .out_dir(out.join("markdown"))
        .generate();
}
