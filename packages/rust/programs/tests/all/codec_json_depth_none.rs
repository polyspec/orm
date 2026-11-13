//! The recipe tests/codec/codec-json-depth.json without a database: a value nested deeper than the 256 levels of the
//! ordered-json parser is refused (COD-70 `json-depth`).
//! Requirements: COD-70.

use polyspec_orm_tests::recipe;

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    recipe::trials("codec_json_depth_none", "tests/codec/codec-json-depth.json", recipe::NONE)
}
