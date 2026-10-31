//! The recipe tests/codec/codec-integer-beyond-i64.json without a database: an integer beyond i64 is refused (COD-62).
//! Requirements: COD-62.

use polyspec_orm_tests::recipe;

fn main() {
    polyspec_orm_testcase::run(recipe::trials("codec_integer_beyond_i64", "tests/codec/codec-integer-beyond-i64.json", recipe::NONE));
}
