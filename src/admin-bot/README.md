# Admin Bot M5

Telegraf lifecycle dan exact Owner ID guard melindungi message serta callback query. `/start` membuka menu lengkap Accounts, Channels, Rules, Reply Templates, Status, dan Health. Tombol Reply Templates membuka pemilih account.

Add Account meminta nickname unik sebelum phone, OTP, dan 2FA. OTP dan 2FA tetap diterima sebagai text input ketika diminta, kemudian message dicoba dihapus. Command lama hanya dipertahankan untuk backward compatibility.

Menu Rules memuat input global Trigger, Exclude, Cleanup, akses pemilih account untuk Reply Templates, Settings/Status, serta CRUD dan enable/disable rule per-channel. Reply Template per-account dapat dikelola langsung dari `Accounts → account detail → 💬 Reply Templates`; seluruh callback tetap exact Owner-only dan account-scoped.

M5 menambahkan per-account Reply Delay, Auto Reaction, Cooldown, hourly/daily limits, channel BLOCKED/Resume, serta Owner-only STOP ALL/RESUME ALL. M6 menyediakan target Monitoring Bot per account untuk notification operasional; safety cleanup tetap ke Owner/Admin Bot. Logs dashboard dan statistics UI belum diimplementasikan.
