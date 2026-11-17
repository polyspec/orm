//! The owned machine of a utility of the contract (CORE-181).

use std::future::Future;

use binding_core::machine::{Machine, Step, Wait};
use binding_core::{Passthrough, Raised};

use crate::{Error, Result};

/// The machine of a member of `utils`, `schema_utils`, `privilege_utils` and `aes_utils` that sends statements: one
/// owned I/O operation and its unchanged result, as `Execute` is for `db.execute` (CORE-127). It calls no language
/// code. The operation owns the utilities and the arguments of the call; making the machine and advancing it send no
/// statement, and a machine that is dropped before it gives its `Io` sends none.
pub struct Operation<T> {
    stage: Stage<T>,
}

enum Stage<T> {
    Ready(Wait<Result<T>>),
    Waiting,
    Done,
}

impl<T: Send + 'static> Operation<T> {
    pub(crate) fn new(operation: impl Future<Output = Result<T>> + Send + 'static) -> Self {
        Self { stage: Stage::Ready(Box::pin(operation)) }
    }
}

impl<T: Send + 'static> Machine for Operation<T> {
    type Io = Result<T>;
    type Done = Result<T>;

    fn resume(&mut self, io: Option<Self::Io>) -> Step<Self::Io, Self::Done> {
        match (std::mem::replace(&mut self.stage, Stage::Done), io) {
            (Stage::Ready(operation), None) => {
                self.stage = Stage::Waiting;
                Step::Io(operation)
            }
            (Stage::Waiting, Some(result)) => Step::Done(result),
            _ => Step::Done(Err(Error::internal("the machine of a utility was advanced out of order"))),
        }
    }

    fn call(&mut self) {}

    fn settle(&mut self, _outcome: std::result::Result<Passthrough, Raised>) {}
}
