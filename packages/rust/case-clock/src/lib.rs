//! A time limit that a test puts on its own computation is measured in the CPU time used by the thread that runs it. On a shared
//! machine, wall-clock time also includes time spent waiting while another process uses the CPU, so it does not measure
//! the work the code did. Wall-clock time is only printed alongside. A timer that ends a stuck case, and a limit on work done by
//! a database or another process, use wall-clock time.
use std::time::{Duration, Instant};

/// Measures the wall-clock time and the thread CPU time of one case together. The case runs on the thread that made this value.
pub struct CaseClock {
    wall: Instant,
    cpu: Duration,
}

impl CaseClock {
    pub fn start() -> Self {
        Self { wall: Instant::now(), cpu: thread_cpu() }
    }

    /// The user and system CPU time this thread has used since the start.
    pub fn cpu(&self) -> Duration {
        thread_cpu() - self.cpu
    }

    pub fn wall(&self) -> Duration {
        self.wall.elapsed()
    }
}

/// The CPU time this thread has used up to now.
pub fn thread_cpu() -> Duration {
    let now = rustix::time::clock_gettime(rustix::time::ClockId::ThreadCPUTime);
    Duration::new(now.tv_sec as u64, now.tv_nsec as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Sleeping time is not counted in CPU time; it is counted only in wall-clock time.
    #[test]
    fn case_clock_does_not_count_time_off_the_cpu() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        let clock = CaseClock::start();
        std::thread::sleep(Duration::from_millis(200));
        let (cpu, wall) = (clock.cpu(), clock.wall());
        println!("TIME sleep cpu={cpu:?} wall={wall:?}");
        assert!(wall >= Duration::from_millis(200), "wall {wall:?}");
        // The clock's own correctness: the sleep counts in the wall-clock time and not in the CPU time, so the CPU time
        // is a small part of it. Both are measured together, so the check compares them and holds under any load.
        assert!(cpu * 4 < wall, "cpu {cpu:?} is not a small part of wall {wall:?}");
    }
}
