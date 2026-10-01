//! test가 자기 계산에 두는 시간 제한은 그 계산을 실행한 thread가 쓴 CPU 시간으로 잰다. 공유
//! machine에서 wall-clock 시간은 다른 process가 CPU를 쓰는 동안 기다린 시간도 담으므로 code가
//! 한 일을 재지 못한다. wall-clock 시간은 함께 출력만 한다. 멈춘 case를 끊는 timer와 database나
//! 다른 process가 하는 일의 제한은 wall-clock 시간을 쓴다.
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

    /// 시작 뒤 이 thread가 쓴 user와 system CPU 시간이다.
    pub fn cpu(&self) -> Duration {
        thread_cpu() - self.cpu
    }

    pub fn wall(&self) -> Duration {
        self.wall.elapsed()
    }
}

/// 지금 thread가 지금까지 쓴 CPU 시간이다.
pub fn thread_cpu() -> Duration {
    let mut now = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    // SAFETY: now는 clock_gettime이 쓸 수 있는 timespec이다.
    let rc = unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut now) };
    assert_eq!(rc, 0, "clock_gettime(CLOCK_THREAD_CPUTIME_ID): {}", std::io::Error::last_os_error());
    Duration::new(now.tv_sec as u64, now.tv_nsec as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    // 잠든 시간은 CPU 시간에 들어가지 않고 wall-clock 시간에만 들어간다.
    #[test]
    fn case_clock_does_not_count_time_off_the_cpu() {
        let clock = CaseClock::start();
        std::thread::sleep(Duration::from_millis(200));
        let (cpu, wall) = (clock.cpu(), clock.wall());
        println!("TIME sleep cpu={cpu:?} wall={wall:?}");
        assert!(wall >= Duration::from_millis(200), "wall {wall:?}");
        assert!(cpu < Duration::from_millis(50), "cpu {cpu:?}");
    }
}
