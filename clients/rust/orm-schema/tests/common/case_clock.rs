//! graph test의 제한 시간은 case를 실행한 thread가 쓴 CPU 시간으로 잰다(docs/schema.md).
//! 공유 machine에서 wall-clock 시간은 다른 process가 CPU를 쓰는 동안 기다린 시간도 담으므로
//! code가 한 일을 재지 못한다. wall-clock 시간은 출력만 한다.
use std::time::{Duration, Instant};

/// 한 case의 wall-clock 시간과 thread CPU 시간을 함께 잰다. case는 이 값을 만든 thread에서 돈다.
pub struct CaseClock {
    wall: Instant,
    cpu: Duration,
}

impl CaseClock {
    pub fn start() -> Self {
        Self { wall: Instant::now(), cpu: thread_cpu() }
    }

    pub fn wall(&self) -> Duration {
        self.wall.elapsed()
    }

    /// case의 thread CPU 시간이 limit보다 짧은지 확인하고 두 시간을 출력한다.
    pub fn assert_within(&self, id: &str, limit: Duration) {
        let (cpu, wall) = (thread_cpu() - self.cpu, self.wall());
        println!("TIME {id} cpu={cpu:?} wall={wall:?}");
        assert!(cpu < limit, "{id}: thread CPU {cpu:?} exceeds {limit:?} (wall {wall:?})");
    }
}

fn thread_cpu() -> Duration {
    let mut now = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    // SAFETY: now는 clock_gettime이 쓸 수 있는 timespec이다.
    let rc = unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut now) };
    assert_eq!(rc, 0, "clock_gettime(CLOCK_THREAD_CPUTIME_ID): {}", std::io::Error::last_os_error());
    Duration::new(now.tv_sec as u64, now.tv_nsec as u32)
}
