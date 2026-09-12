//! Per-query execution handle. Binding never changes the IR or a global connection.
use crate::db::{Db, Exec, Tx};
use crate::plan::Step;
use crate::row::DriverRow;
use crate::value::Param;
use crate::{Error, Result};

#[derive(Clone)]
pub enum BoundExec {
    Database(Db),
    Transaction(Tx),
}

#[derive(Clone, Default)]
pub struct Binding(Option<BoundExec>);

impl std::fmt::Debug for Binding {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match &self.0 {
            None => "Binding(unbound)",
            Some(BoundExec::Database(_)) => "Binding(database)",
            Some(BoundExec::Transaction(_)) => "Binding(transaction)",
        })
    }
}

impl Binding {
    pub fn new(ex: &impl Exec) -> Self {
        Self(Some(match ex.tx() {
            Some(tx) => BoundExec::Transaction(tx.clone()),
            None => BoundExec::Database(ex.db().clone()),
        }))
    }

    pub fn resolve(&self) -> Result<&BoundExec> {
        let ex = self.0.as_ref().ok_or_else(|| {
            Error::Config("bind a database or transaction before executing".into())
        })?;
        if let BoundExec::Transaction(tx) = ex {
            tx.assert_active()?;
        }
        Ok(ex)
    }
}

impl Exec for BoundExec {
    fn db(&self) -> &Db {
        match self {
            Self::Database(db) => db,
            Self::Transaction(tx) => tx.db(),
        }
    }
    fn tx(&self) -> Option<&Tx> {
        match self {
            Self::Database(_) => None,
            Self::Transaction(tx) => Some(tx),
        }
    }
    async fn query(
        &self,
        st: &Step,
        params: &[Param],
        parents: Vec<Param>,
    ) -> Result<Vec<DriverRow>> {
        match self {
            Self::Database(db) => db.query(st, params, parents).await,
            Self::Transaction(tx) => tx.query(st, params, parents).await,
        }
    }
    async fn execute(&self, st: &Step, params: &[Param]) -> Result<(u64, u64)> {
        match self {
            Self::Database(db) => db.execute(st, params).await,
            Self::Transaction(tx) => tx.execute(st, params).await,
        }
    }
}
