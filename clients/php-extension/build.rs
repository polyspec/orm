// PHP symbol은 확장을 load하는 PHP binary가 해결하므로 macOS linker가 link 시점에 요구하지 않게 한다.
// cargo를 다른 directory에서 --manifest-path로 실행해도 적용되도록 .cargo/config.toml이 아니라 여기서 출력한다.
fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo::rustc-link-arg-cdylib=-Wl,-undefined,dynamic_lookup");
    }
}
