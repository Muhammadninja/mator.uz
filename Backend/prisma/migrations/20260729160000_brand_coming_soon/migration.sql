-- Add a "coming soon" teaser flag to vehicle makes (brands). Brands flagged
-- coming_soon are shown in the app dimmed with a "Soon" badge and are not
-- tappable; operators toggle this in the admin brands console.
ALTER TABLE "vehicle_makes" ADD COLUMN "coming_soon" BOOLEAN NOT NULL DEFAULT false;
