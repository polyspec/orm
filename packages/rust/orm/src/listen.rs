//! LISTEN and NOTIFY on PostgreSQL (docs/spec/dialects.md DIA-192 to DIA-196, PRT-74). A notify runs on the connection of the
//! active transaction, so it is delivered with that commit. A subscription holds a connection of its own, outside the pool:
//! a pool of one connection with the options of the database.

use std::time::Duration;

use sqlx::postgres::{PgListener, PgPool, PgPoolOptions};

use crate::codes;
use crate::db::{Db, Executor};
use crate::events::KIND_UTILITY;
use crate::tx::active_for;
use crate::utils::step;
use crate::value::Param;
use crate::{Error, Result};

/// One notification that a subscription receives (DIA-194): the channel, the payload and the process id of the sender.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notification {
    pub channel: String,
    pub payload: String,
    pub pid: u32,
}

/// A LISTEN subscription (DIA-194 and DIA-195). `receive_within` takes a deadline: one that expires fails the receive with CANCELED
/// and closes the subscription, which then fails further calls with CONFIG. `close` runs UNLISTEN for every channel and ends the
/// connection.
pub struct Subscription {
    inner: Option<(PgListener, PgPool)>,
}

impl Db {
    /// Sends `payload` to `channel` with pg_notify (DIA-193). Inside a transaction of this handle it runs on that transaction's
    /// connection; outside one it runs on its own statement. MySQL, SQLite and the markdown executor refuse it (DIA-196).
    pub async fn notify(&self, channel: &str, payload: &str) -> Result<()> {
        self.listenable("notify")?;
        check_channel(channel)?;
        let ex = match active_for(self) {
            Some(t) => Executor::Tx(t),
            None => Executor::Db(self.clone()),
        };
        ex.execute_as(
            Some(KIND_UTILITY),
            Some(&[] as &[String]),
            &step("SELECT pg_notify($1, $2)".into(), &["text", "text"]),
            &[Param::Str(channel.into()), Param::Str(payload.into())],
        )
        .await?;
        Ok(())
    }

    /// Opens a LISTEN subscription on `channel` (DIA-194) on a connection of its own. MySQL, SQLite and the markdown executor refuse it
    /// with CAPABILITY_UNSUPPORTED (DIA-196).
    pub async fn listen(&self, channel: &str) -> Result<Subscription> {
        self.listenable("listen")?;
        check_channel(channel)?;
        let options = self.inner.listen.clone().ok_or_else(|| Error::Config("this connection has no LISTEN connection".into()))?;
        let pool = PgPoolOptions::new().max_connections(1).connect_with(options).await?;
        let mut listener = match PgListener::connect_with(&pool).await {
            Ok(listener) => listener,
            Err(error) => {
                pool.close().await;
                return Err(error.into());
            }
        };
        if let Err(error) = listener.listen(channel).await {
            pool.close().await;
            return Err(error.into());
        }
        Ok(Subscription { inner: Some((listener, pool)) })
    }

    /// The error of a LISTEN or NOTIFY operation on a connection without it (DIA-196).
    fn listenable(&self, surface: &str) -> Result<()> {
        if self.driver() != "postgres" {
            return Err(Error::Engine { code: codes::CAPABILITY_UNSUPPORTED.into(), msg: format!("{surface} is supported on PostgreSQL only") });
        }
        Ok(())
    }
}

impl Subscription {
    /// Waits up to `deadline` for the next notification (DIA-194). A deadline that expires fails the receive with CANCELED and closes
    /// the subscription (DIA-195); the connection is then dropped without UNLISTEN, because a receive that the deadline ended may
    /// have left its connection mid-message.
    pub async fn receive_within(&mut self, deadline: Duration) -> Result<Notification> {
        let Some((listener, _)) = self.inner.as_mut() else {
            return Err(closed());
        };
        match tokio::time::timeout(deadline, listener.recv()).await {
            Ok(n) => {
                let n = n?;
                Ok(Notification { channel: n.channel().to_owned(), payload: n.payload().to_owned(), pid: n.process_id() })
            }
            Err(_) => {
                self.inner = None;
                Err(Error::Engine { code: codes::CANCELED.into(), msg: "the receive of the LISTEN subscription expired".into() })
            }
        }
    }

    /// Stops delivery of `channel` (DIA-195).
    pub async fn unlisten(&mut self, channel: &str) -> Result<()> {
        check_channel(channel)?;
        let Some((listener, _)) = self.inner.as_mut() else {
            return Err(closed());
        };
        listener.unlisten(channel).await?;
        Ok(())
    }

    /// Runs UNLISTEN for every channel and ends the connection (DIA-195). Closing a closed subscription does nothing.
    pub async fn close(mut self) -> Result<()> {
        let Some((mut listener, pool)) = self.inner.take() else {
            return Ok(());
        };
        let unlisten = listener.unlisten_all().await;
        // The pool waits for its connections to return, and the listener holds one until it is dropped.
        drop(listener);
        pool.close().await;
        unlisten.map_err(Error::from)
    }
}

fn closed() -> Error {
    Error::Config("the LISTEN subscription is closed".into())
}

/// Checks a channel of 1 to 63 bytes without U+0000 (DIA-192).
fn check_channel(channel: &str) -> Result<()> {
    if channel.is_empty() || channel.len() > 63 || channel.contains('\0') {
        return Err(Error::Config("a channel is 1 to 63 bytes without U+0000".into()));
    }
    Ok(())
}
