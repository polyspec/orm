//! Shared checked byte accounting for typed row assignments.

pub(super) const MAX_BYTES: usize = 8 * 1024 * 1024;

pub(super) fn add(current: usize, name_bytes: usize, value_bytes: usize) -> Option<usize> {
    current.checked_add(name_bytes).and_then(|total| total.checked_add(value_bytes)).filter(|total| *total <= MAX_BYTES)
}

#[cfg(test)]
#[path = "../../tests/unit/assignment_budget.rs"]
mod tests;
