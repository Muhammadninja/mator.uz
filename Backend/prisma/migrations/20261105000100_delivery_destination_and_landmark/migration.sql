-- A readable hint for the courier on a saved address, such as "blue gate, second entrance".
-- A map pin needs no street address, so this may be the only words a destination has.
ALTER TABLE "addresses" ADD COLUMN "landmark" VARCHAR(200);

-- Where a courier order goes, as confirmed when it was placed: the exact point the buyer
-- chose and the words that went with it, as { addressId, lat, lng, label, fullText,
-- regionCode, district, street, landmark }. The buyer can edit or delete the address row
-- afterwards, and the order must not move with it.
--
-- Not served to the buyer. Account deletion clears it, since it holds a buyer's location.
--
-- Additive: two nullable columns, no default, no backfill, no index. Orders placed before
-- this stay null, as do pickup orders.
--
-- Deploy before the code: Prisma selects every column of a row by default, so the new code
-- reading an order or an address fails until these columns exist.
ALTER TABLE "orders" ADD COLUMN "delivery_destination" JSONB;
