//! Builds one timed async trial for every JSON fixture case.

macro_rules! json_trials {
    ($cases:expr, $prefix:expr, $deadline:expr, $handler:path) => {{
        $cases
            .iter()
            .enumerate()
            .map(|(index, case)| {
                let id = case["id"].as_str().expect("id").to_owned();
                let case = case.clone();
                polyspec_orm_testcase::async_trial(format!("{}::{id}", $prefix), $deadline, move || async move { $handler(index, &case).await })
            })
            .collect()
    }};
}
