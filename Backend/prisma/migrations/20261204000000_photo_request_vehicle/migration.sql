-- The customer's selected car, so staff know which vehicle the photo is for.
ALTER TABLE "photo_requests" ADD COLUMN "vehicle_label" VARCHAR(160);
