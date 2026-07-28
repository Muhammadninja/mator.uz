-- order_status_history.actor_id was typed `uuid`, which only fits app-USER actor
-- ids. Operator status writes (PATCH /v1/orders/:id/status) attribute the ADMIN
-- actor, whose id is a cuid (app_admins.id, @default(cuid())) — NOT a uuid — so
-- the history insert failed with "invalid input syntax for type uuid", rolling
-- back the whole transition (500, status unchanged).
--
-- Widen the column to hold ids from BOTH realms. It is NOT a foreign key, so this
-- is a safe additive widening; existing uuid values are preserved as their text
-- form. The USING clause is required to cast the existing uuid column to text.
ALTER TABLE "order_status_history"
  ALTER COLUMN "actor_id" TYPE VARCHAR(64) USING "actor_id"::text;
