//! One test program with many groups of trials. A group is what a test program of its own was: its trials run together as
//! `--test-threads` says, the groups run one after another, and a run says its size and its progress.
use std::time::Instant;

use libtest_mimic::{Arguments, Trial};

/// The trials of one module of a test program. Every trial is named `<group>::<name>`, so that the filter `<group>::` selects them.
pub struct Group {
    name: &'static str,
    trials: fn() -> Vec<Trial>,
    in_order: bool,
    after: Option<fn()>,
}

impl Group {
    /// The group `name`, whose trials `trials` builds only when the command line can select one of them.
    pub fn new(name: &'static str, trials: fn() -> Vec<Trial>) -> Self {
        Self { name, trials, in_order: false, after: None }
    }

    /// The trials share a database or a server: unless the command line gives `--test-threads`, they run one after another, in
    /// the order of the file.
    pub fn in_order(mut self) -> Self {
        self.in_order = true;
        self
    }

    /// Runs `after` once every trial of the group has ended: it releases what the trials shared.
    pub fn after(mut self, after: fn()) -> Self {
        self.after = Some(after);
        self
    }
}

/// The options of the libtest command line that take their value as the next argument.
const VALUE_OPTIONS: [&str; 6] = ["--skip", "--test-threads", "--logfile", "--color", "--format", "-Z"];

/// Divides a command line into its name filters, of which libtest takes several and libtest-mimic one, and the rest.
fn split_filters(arguments: Vec<String>) -> (Vec<String>, Vec<String>) {
    let (mut filters, mut rest) = (Vec::new(), Vec::new());
    let mut arguments = arguments.into_iter();
    rest.extend(arguments.next());
    while let Some(argument) = arguments.next() {
        if VALUE_OPTIONS.contains(&argument.as_str()) {
            rest.push(argument);
            rest.extend(arguments.next());
        } else if argument.starts_with('-') {
            rest.push(argument);
        } else {
            filters.push(argument);
        }
    }
    (filters, rest)
}

/// Whether a filter can select a trial of `group`: a filter with `::` names the end of a group before it, or the group exactly
/// under `--exact`, and a filter without one can match any trial.
fn may_select(group: &str, filter: &str, exact: bool) -> bool {
    match filter.split_once("::") {
        None => !exact,
        Some((head, _)) if exact => head == group,
        Some((head, _)) => group.ends_with(head),
    }
}

/// Whether `name` matches `pattern` as libtest matches a filter or a skip.
fn matches(name: &str, pattern: &str, exact: bool) -> bool {
    if exact {
        name == pattern
    } else {
        name.contains(pattern)
    }
}

/// Runs `groups` with the arguments of the test program's command line and exits with the result: 101 when a trial failed.
pub fn run_groups(groups: Vec<Group>) -> ! {
    let (filters, rest) = split_filters(std::env::args().collect());
    let mut arguments = Arguments::from_iter(rest);
    let (exact, skip) = (arguments.exact, std::mem::take(&mut arguments.skip));
    let selected = |name: &str| {
        (filters.is_empty() || filters.iter().any(|filter| matches(name, filter, exact))) && !skip.iter().any(|pattern| matches(name, pattern, exact))
    };
    let mut chosen = Vec::new();
    for group in groups {
        if !filters.is_empty() && !filters.iter().any(|filter| may_select(group.name, filter, exact)) {
            continue;
        }
        let trials: Vec<Trial> = (group.trials)();
        let prefix = format!("{}::", group.name);
        if let Some(stray) = trials.iter().find(|trial| !trial.name().starts_with(&prefix)) {
            panic!("the trial {} is outside its group {}", stray.name(), group.name);
        }
        let trials: Vec<Trial> = trials.into_iter().filter(|trial| selected(trial.name())).collect();
        if !trials.is_empty() {
            chosen.push((group, trials));
        }
    }
    if arguments.list {
        libtest_mimic::run(&arguments, chosen.into_iter().flat_map(|(_, trials)| trials).collect()).exit();
    }
    let total: usize = chosen.iter().map(|(_, trials)| trials.len()).sum();
    let (groups_total, started) = (chosen.len(), Instant::now());
    let (mut done, mut passed, mut failed, mut ignored) = (0, 0, 0, 0);
    let mut failed_groups = Vec::new();
    for (index, (group, trials)) in chosen.into_iter().enumerate() {
        let size = trials.len();
        println!("group {}/{groups_total} {}: {size} tests; {done} of {total} done in {}", index + 1, group.name, crate::duration(started.elapsed()));
        let mut group_arguments = arguments.clone();
        if group.in_order {
            group_arguments.test_threads.get_or_insert(1);
        }
        let conclusion = libtest_mimic::run(&group_arguments, trials);
        if let Some(after) = group.after {
            after();
        }
        done += size;
        passed += conclusion.num_passed;
        failed += conclusion.num_failed;
        ignored += conclusion.num_ignored;
        if conclusion.has_failed() {
            failed_groups.push(group.name);
        }
    }
    let state = if failed == 0 { "ok" } else { "FAILED" };
    println!(
        "all groups: {state}. {passed} passed; {failed} failed; {ignored} ignored; {total} tests in {groups_total} groups, finished in {}",
        crate::duration(started.elapsed())
    );
    if !failed_groups.is_empty() {
        println!("groups with a failure: {}", failed_groups.join(" "));
        std::process::exit(101);
    }
    std::process::exit(0);
}

/// The trials of plain functions of a module, named `<group>::<function>`. Each function starts its own case and its own runtime.
#[macro_export]
macro_rules! native_trials {
    ($group:literal: $($test:ident),+ $(,)?) => {
        vec![$($crate::Trial::test(concat!($group, "::", stringify!($test)), || {
            $test();
            Ok(())
        })),+]
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(words: &[&str]) -> Vec<String> {
        words.iter().map(|word| (*word).to_owned()).collect()
    }

    #[test]
    fn filters_are_the_arguments_that_no_option_takes() {
        let _case = crate::case!(crate::COMPUTE);
        let (filters, rest) = split_filters(line(&["all", "a::", "--skip", "b", "--exact", "c::d", "--test-threads", "1", "--nocapture", "--skip=e"]));
        assert_eq!(filters, line(&["a::", "c::d"]));
        assert_eq!(rest, line(&["all", "--skip", "b", "--exact", "--test-threads", "1", "--nocapture", "--skip=e"]));
    }

    #[test]
    fn a_filter_with_a_group_builds_only_the_groups_it_can_select() {
        let _case = crate::case!(crate::COMPUTE);
        assert!(may_select("dsn_connection_mysql", "dsn_connection_mysql::", false));
        assert!(may_select("dsn_connection_mysql", "mysql::x", false));
        assert!(!may_select("dsn_connection_mysql", "postgres::x", false));
        assert!(may_select("dsn_connection_mysql", "dsn_connection", false));
        assert!(may_select("dsn_connection_mysql", "dsn_connection_mysql::x", true));
        assert!(!may_select("dsn_connection_mysql", "mysql::x", true));
        assert!(!may_select("dsn_connection_mysql", "dsn_connection_mysql", true));
    }

    #[test]
    fn a_name_matches_as_libtest_matches_it() {
        let _case = crate::case!(crate::COMPUTE);
        assert!(matches("a::b", "a::", false));
        assert!(matches("a::b", "a::b", true));
        assert!(!matches("a::b", "a::", true));
        assert!(!matches("a::b", "c", false));
    }
}
