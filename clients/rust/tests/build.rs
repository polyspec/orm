fn main() {
    orm_build::Builder::new("../../../schema/schema.json")
        .scan("src")
        .scan("../../../examples/complex/rust")
        .scan("../../../examples/thin-slice/rust")
        .generate();
}
