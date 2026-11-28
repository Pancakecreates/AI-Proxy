use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::watch;

/// Токен отмены с памятью состояния: в отличие от голого Notify,
/// отмена не теряется, если она произошла до входа backend в select!.
pub struct CancelToken {
    cancelled: AtomicBool,
    tx: watch::Sender<bool>,
}

impl CancelToken {
    pub fn new() -> Arc<Self> {
        let (tx, _) = watch::channel(false);
        Arc::new(Self {
            cancelled: AtomicBool::new(false),
            tx,
        })
    }

    pub fn cancel(&self) {
        if self.cancelled.swap(true, Ordering::SeqCst) {
            return;
        }
        let _ = self.tx.send(true);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    pub async fn cancelled(&self) {
        if self.is_cancelled() {
            return;
        }
        let mut rx = self.tx.subscribe();
        if self.is_cancelled() || *rx.borrow() {
            return;
        }
        while rx.changed().await.is_ok() {
            if *rx.borrow() {
                return;
            }
        }
    }
}

/// Drop-guard для handler-фьючеры axum: если клиент оборвал non-streaming
/// запрос и hyper выкинул handler, фоновый backend-turn всё равно получает cancel.
pub struct CancelOnDrop {
    token: Arc<CancelToken>,
    armed: bool,
}

impl CancelOnDrop {
    pub fn new(token: Arc<CancelToken>) -> Self {
        Self { token, armed: true }
    }

    pub fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if self.armed {
            self.token.cancel();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancellation_is_remembered_before_wait() {
        let token = CancelToken::new();
        token.cancel();
        tokio::time::timeout(std::time::Duration::from_millis(100), token.cancelled())
            .await
            .expect("cancel state must be sticky");
    }

    #[tokio::test]
    async fn cancellation_wakes_all_current_waiters() {
        let token = CancelToken::new();
        let mut tasks = Vec::new();
        for _ in 0..8 {
            let token = token.clone();
            tasks.push(tokio::spawn(async move { token.cancelled().await }));
        }
        tokio::task::yield_now().await;
        token.cancel();
        for task in tasks {
            tokio::time::timeout(std::time::Duration::from_millis(100), task)
                .await
                .expect("waiter did not wake")
                .expect("waiter task panicked");
        }
    }

    #[tokio::test]
    async fn repeated_cancel_is_idempotent() {
        let token = CancelToken::new();
        token.cancel();
        token.cancel();
        assert!(token.is_cancelled());
        tokio::time::timeout(std::time::Duration::from_millis(100), token.cancelled())
            .await
            .expect("cancel state must remain sticky");
    }
}
