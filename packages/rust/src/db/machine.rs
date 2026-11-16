//! The owned machine of compiled-step execution (CORE-127), on the pool and in a transaction.

use binding_core::machine::{Machine, Step};
use binding_core::{Failure, Passthrough, Raised};

use crate::{Db, Error, OrmValue, Result, Tx};

/// Where an [`Execute`] runs its statement: the pool of a connection or a transaction handle.
pub(crate) enum Target {
    Db(Db),
    Tx(Tx),
}

/// The machine of `Db::execute_text_machine` and `Tx::execute_text_machine`: one owned I/O operation and its unchanged
/// result.
pub struct Execute {
    stage: Stage,
}

enum Stage {
    Ready { target: Target, step: String, params: Vec<OrmValue> },
    Waiting,
    Done,
}

impl Execute {
    pub(crate) fn new(target: Target, step: String, params: Vec<OrmValue>) -> Self {
        Self { stage: Stage::Ready { target, step, params } }
    }
}

impl Machine for Execute {
    type Io = Result<()>;
    type Done = Result<()>;

    fn resume(&mut self, io: Option<Self::Io>) -> Step<Self::Io, Self::Done> {
        match (std::mem::replace(&mut self.stage, Stage::Done), io) {
            (Stage::Ready { target, step, params }, None) => {
                self.stage = Stage::Waiting;
                // Keep parsing and scalar conversion inside the native operation, in their existing order (FMS-42).
                Step::Io(Box::pin(async move {
                    match target {
                        Target::Db(db) => db.execute_text(&step, params).await,
                        Target::Tx(tx) => tx.execute_text(&step, params).await,
                    }
                }))
            }
            (Stage::Waiting, Some(result)) => Step::Done(result),
            _ => Step::Done(Err(Error::internal("the machine of execute was advanced out of order"))),
        }
    }

    fn call(&mut self) {}

    fn settle(&mut self, _outcome: std::result::Result<Passthrough, Raised>) {}
}

/// The machine of `Db::connect_machine` and `Db::connect_schema_machine` (CORE-132): one owned I/O operation that opens
/// the connection, and its unchanged result. It calls no language code.
pub struct Connect {
    stage: Opening,
}

/// The arguments of a [`Connect`] that has not opened its connection.
struct Arguments {
    dsn: String,
    schema: Option<crate::Schema>,
    pool_size: u32,
    cfg: crate::Config,
}

enum Opening {
    Ready(Box<Arguments>),
    Waiting,
    Done,
}

impl Connect {
    pub(crate) fn new(dsn: String, schema: Option<crate::Schema>, pool_size: u32, cfg: crate::Config) -> Self {
        Self { stage: Opening::Ready(Box::new(Arguments { dsn, schema, pool_size, cfg })) }
    }
}

impl Machine for Connect {
    type Io = Result<Db>;
    /// A failure of the connection is a kind of the core; the `Failure` is the result form of a member that reaches
    /// language code (binding GN-6ab, CORE-132).
    type Done = std::result::Result<Db, Failure<Error>>;

    fn resume(&mut self, io: Option<Self::Io>) -> Step<Self::Io, Self::Done> {
        match (std::mem::replace(&mut self.stage, Opening::Done), io) {
            (Opening::Ready(arguments), None) => {
                let Arguments { dsn, schema, pool_size, cfg } = *arguments;
                self.stage = Opening::Waiting;
                Step::Io(Box::pin(async move {
                    match schema {
                        Some(schema) => Db::connect_schema(&dsn, &schema, pool_size, cfg).await,
                        None => Db::connect(&dsn, pool_size, cfg).await,
                    }
                }))
            }
            (Opening::Waiting, Some(result)) => Step::Done(result.map_err(Failure::Kind)),
            _ => Step::Done(Err(Failure::Kind(Error::internal("the machine of connect was advanced out of order")))),
        }
    }

    fn call(&mut self) {}

    fn settle(&mut self, _outcome: std::result::Result<Passthrough, Raised>) {}
}
