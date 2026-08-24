# Telegram user-client final runtime

Wrapper lifecycle GramJS dan registry membuat satu client per `accountKey`. Adapter mendukung connect, disconnect, reconnect, authorization check, user login, dan session export.

OTP/2FA orchestration dan persistent storage dimiliki module `accounts`; user-client tidak membaca session account lain. Event subscription tetap scoped per client/channel dan memetakan event ke broadcast channel post, supergroup/discussion, atau unknown sebelum detector. Runtime final menyediakan account-scoped `commentTo`, optional ❤️ reaction pada reply/comment yang dikirim, serta operational notification ke Monitoring Bot target per account; semuanya hanya dipanggil setelah hard channel-only gate dan persistent dispatch claim.
