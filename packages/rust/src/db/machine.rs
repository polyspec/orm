//! The owned machine of compiled-step execution (CORE-127).

use binding_core::machine::{Machine, Step};
use binding_core::{Passthrough, Raised};

use crate::{Db, Error, OrmValue, Result};

/// The machine of `Db::execute_text_machine`: one owned I/O operation and its unchanged result.
pub struct Execute {
    stage: Stage,
}

enum Stage {
    Ready { db: Db, step: String, params: Vec<OrmValue> },
    Waiting,
    Done,
}

impl Execute {
    pub(crate) fn new(db: Db, step: String, params: Vec<OrmValue>) -> Self {
        Self { stage: Stage::Ready { db, step, params } }
    }
}

impl Machine for Execute {
    type Io = Result<()>;
    type Done = Result<()>;

    fn resume(&mut self, io: Option<Self::Io>) -> Step<Self::Io, Self::Done> {
        match (std::mem::replace(&mut self.stage, Stage::Done), io) {
            (Stage::Ready { db, step, params }, None) => {
                self.stage = Stage::Waiting;
                // Keep parsing and scalar conversion inside the native operation, in their existing order (FMS-42).
                Step::Io(Box::pin(async move { db.execute_text(&step, params).await }))
            }
            (Stage::Waiting, Some(result)) => Step::Done(result),
            _ => Step::Done(Err(Error::internal("the machine of execute was advanced out of order"))),
        }
    }

    fn call(&mut self) {}

    fn settle(&mut self, _outcome: std::result::Result<Passthrough, Raised>) {}
}
