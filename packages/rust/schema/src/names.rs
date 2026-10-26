/// Converts an ASCII Pascal-style or camel-style identifier to snake case.
pub fn snake_case(value: &str) -> String {
    let mut out = String::new();
    for (index, ch) in value.chars().enumerate() {
        if ch.is_ascii_uppercase() {
            if index > 0 {
                out.push('_');
            }
            out.push(ch.to_ascii_lowercase());
        } else {
            out.push(ch);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    // Requirements: DBS-111.
    #[test]
    fn snake_case_separates_ascii_uppercase_characters() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        assert_eq!(super::snake_case("AuthorUUID"), "author_u_u_i_d");
        assert_eq!(super::snake_case("already_snake"), "already_snake");
    }
}
