# Render backend: manual crypto deposits

This backend is separate from the root Websim Worker. It serves the project files from the parent directory and handles the authentication and deposit-review routes used by the deposit flow. Configure Render to start it with:

```sh
npm install pg
node render-backend/server.js
```

The existing GitHub repository already lists Express. Add `pg` to its dependencies before deploying (or use the build command above). Do not commit a database URL, admin password, or private wallet key.

## Render environment

Set these in the Render service's Environment page:

- `DATABASE_URL`: link the Render PostgreSQL database to the service and use its **Internal Database URL**. The service ID `srv-db8j58ei0phs73frs08g` is not a connection URL.
- `ADMIN_EMAIL`: the admin login email.
- `ADMIN_PASSWORD_SALT`: random salt, at least 16 characters.
- `ADMIN_PASSWORD_HASH`: scrypt hash of the admin password, 128 lowercase hex characters.
- `DEPOSIT_ADDRESS_BNB_BEP20`: `0x2859d146Dc8e4cB332736986feE9D32B641fbde8`
- `DEPOSIT_ADDRESS_USDT_TRC20`: `TYQgWx4eQ6Js94UMexfyLXbqNE4Fucfg7Y`
- `DEPOSIT_ADDRESS_BTC`: `bc1par0exs9cyw9w53xsceyh6wzl7f43gdjn6xsq0kyq4qsqsvr2uynqf5llc6`
- `ENABLE_CRYPTO_DEPOSITS`: set to `true` only after the complete API, deposit review, and withdrawal/refund policy are ready; otherwise deposits stay disabled.
- `SESSION_TTL_HOURS` (optional; defaults to 168)

Generate an admin password salt and its scrypt hash locally with Node (replace the placeholder password; do not use this example password):

```sh
node --input-type=module -e 'import crypto from "node:crypto"; import {promisify} from "node:util"; const scrypt=promisify(crypto.scrypt); const password=process.argv[1]; const salt=crypto.randomBytes(24).toString("hex"); const hash=(await scrypt(password,salt,64)).toString("hex"); console.log(JSON.stringify({ADMIN_PASSWORD_SALT:salt,ADMIN_PASSWORD_HASH:hash},null,2));' 'YOUR_LONG_ADMIN_PASSWORD'
```

Set the two printed values as Render secrets. Use that same password to sign in with the configured admin email. User passwords are hashed with scrypt; sessions store only SHA-256 token digests.

## Deposit behavior

Supported assets are native BNB on BNB Smart Chain, USDT on TRON TRC-20, and BTC on Bitcoin. Requests are stored as `pending`; they do not change the account balance. The backend checks network-specific TXID shape and enforces a unique `(network, txid)`. This is an anti-duplicate check, not on-chain verification. The admin must independently verify destination, asset, amount, and confirmations using a trusted explorer.

The user enters the requested amount in USD (rounded to cents), selects a network and submits the transaction hash. New requests are marked as USD; historical requests keep their original crypto denomination. This is a requested USD value, not an on-chain conversion or verification. On approval the admin independently checks the transaction and enters the verified USDT credit value. The API atomically records the decision, appends an immutable deposit-ledger row, and credits the deposit balance once. Rejected requests never credit a balance. The service does not hold signing keys or send cryptocurrency.

## Important deployment limitation

This backend implements authentication, account reads, deposit addresses, deposit requests, and admin deposit review. Other app operations that are only present in the old browser mock (including withdrawals, password recovery, investments, and rewards) return HTTP 501 until migrated to server-authoritative routes; they do not fall back to client-side balance changes in production. Crypto deposits are disabled by default and should remain disabled until those operations and a withdrawal/refund policy are implemented. The existing Render service source stores passwords in plaintext and should not be used with real user data. Existing browser-local mock accounts and their balances are not migrated; users must create accounts in the new backend. Do not accept live funds until you have deployed this backend, verified the database and admin login, tested a small deposit end-to-end, and reviewed the legal/compliance obligations for custody of customer funds.
