# Sourcing: first release

Backend for the AI sourcing assistant. The API contract is in the app repo, `docs/backend-sourcing-contract.md`.

## What changed

| Area | Behaviour |
|---|---|
| Authentication | Guests chat and browse. Only a verified user creates tickets or notifies staff. A token that fails is 401, not a guest |
| Request IDs | `Idempotency-Key`, unique per account. Concurrent retries wait for and return the original result. A different message or vehicle on the same key is 409 `IDEMPOTENCY_KEY_REUSED` |
| Vehicle | `X-Selected-Vehicle-Id` is honoured only for the caller's own vehicle. A confirmed misfit isn't returned, and unknown fit stays `UNKNOWN` |
| Several parts | One `SourcingRequest`, one `SourcingTicket` per part, each with its own status and offers |
| Copy | No response-time promises in fixed text or AI instructions. Model text that makes one is replaced |
| Reliability | Staff delivery retries with backoff, escalation, no-offer outcome, offer expiry, customer notices. The inbox row is written regardless of push |
| Privacy | Dealer cards carry the part and vehicle, with no raw message, contact or full VIN. The admin ticket list adds verified customer contact |

## Migration

`prisma/migrations/20261103000000_sourcing_first_release`

- Additive only: two enums, two enum values, one table, nullable or defaulted columns, indexes. No existing row changes.
- **Existing tickets are never re-sent.** `staff_notify_status` is NULL on them, and every background job filters on columns only the new flow sets. There's a test for this.
- `ALTER TYPE ... ADD VALUE` can't be undone by a normal down migration. See "Rollback".

The migration has **not been run against any database**, because this release was prepared without a local database. It was generated with `prisma migrate diff` from the previous schema. Run it for the first time with a backup in place.

**Read-only checks before migrating:**

```sql
SELECT count(*) FROM sourcing_tickets;
SELECT status, count(*) FROM sourcing_tickets GROUP BY status;
SELECT count(*) FROM sourcing_offers;
SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY finished_at DESC LIMIT 5;
```

## Release order

Check first what production runs: this branch is based on `origin/main`, so deploying it also ships anything on `main` that isn't live yet.

1. Back up the database.
2. Set the new variables, with `SOURCING_TICKETS_ENABLED=false`.
3. Deploy with the switch off:
   ```bash
   git fetch origin && git checkout feat/sourcing-first-release && git pull
   cd Backend && npm ci && npx prisma generate && npx prisma migrate deploy && npm run build && pm2 restart mator-backend
   ```
4. Verify with the switch off:
   - `GET /v1/sourcing/capabilities` returns `contract_version: 2` and `ticket_submission_enabled: false`
   - `GET /v1/admin/sourcing-tickets` still lists existing tickets
   - The dealers group received nothing
5. Release the app build. Sourcing stays off for customers while the switch is off.
6. Coordinate the live test: agreed time, dealers group warned, staff member ready.
7. Set `SOURCING_TICKETS_ENABLED=true`, restart, and run the live test.

`npm run build` is required. Pulling alone doesn't change what runs.

## Rollback

**Stop new tickets, which is the first move:** set `SOURCING_TICKETS_ENABLED=false` and restart. Chat and catalogue matches keep working, and customers are told requests can't be taken right now. Existing tickets and offers keep being processed.

**Go back to the previous build:** the new columns and table can stay, since old code ignores them. Old code can't read the new enum values, though, so convert them first:

```sql
UPDATE sourcing_tickets SET status = 'CLOSED' WHERE status = 'NO_OFFER';
UPDATE notifications SET type = 'MARKETING' WHERE type = 'SOURCING_STATUS';
```

Then deploy the previous commit and restart. Don't run `prisma migrate deploy` for the old code, and leave the enum values in place, as they're harmless once unused. After this, the old chat code would again create anonymous tickets and promise a response time, so the app must also stop offering sourcing. The new app does this by itself, because `GET /v1/sourcing/capabilities` will return 404.

## Known limits

- **Not run against a real database or Telegram.** Concurrency was tested against a fake that enforces the unique constraint, so the real constraint and transaction need checking in the live test.
- **At-least-once delivery.** A crash after Telegram accepts a message but before it's recorded repeats that message. Offer and notice claims favour not doubling: a crash mid-delivery can lose one, which is rare but not impossible.
- **Apps with no request ID** (installed versions) get only the open-ticket duplicate check, with no protection against concurrent sends.
- **Car name matching** compares the model's extracted brand and model to the garage vehicle's as plain text. A car written differently ("Кобальт") is treated as another car, so fit stays unknown. That's safe but less helpful.
- **Sourcing requests are kept indefinitely,** as parents of their tickets. Retention isn't covered yet.
