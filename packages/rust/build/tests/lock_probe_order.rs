use polyspec_orm_build::catalog::MutationPhase;
use std::sync::{
    atomic::{AtomicU8, Ordering},
    Arc, Mutex,
};

/// A mutation that answers within one poll runs to its end before a test that only stops polling it can probe
/// anything; a probe that runs inside the Locked publisher sees the mutation at Locked, whatever the scheduling.
#[test]
fn a_probe_inside_the_locked_publisher_sees_the_mutation_at_locked() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    // 0: before Locked, 1: at Locked, 2: finished.
    let stage = Arc::new(std::sync::atomic::AtomicU8::new(0));
    let seen = Arc::new(Mutex::new(None));
    let (probe_stage, probe_seen) = (stage.clone(), seen.clone());
    let publish: Arc<dyn Fn(MutationPhase) + Send + Sync> = Arc::new(move |phase| {
        if phase == MutationPhase::Locked {
            *probe_seen.lock().unwrap() = Some(probe_stage.load(Ordering::SeqCst));
        }
    });
    // The fake mutation never waits: it publishes Locked and finishes within its first poll.
    let mutation = async {
        stage.store(1, Ordering::SeqCst);
        publish(MutationPhase::Locked);
        stage.store(2, Ordering::SeqCst);
    };
    tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(mutation);
    assert_eq!(*seen.lock().unwrap(), Some(1), "the probe ran while the mutation was at Locked");
    assert_eq!(stage.load(Ordering::SeqCst), 2);
}
