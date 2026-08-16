-- Localized category titles. Nullable so every existing row stays valid; the
-- buyer app renders title_uz (uz) / title_ru (else), each falling back to name.
ALTER TABLE "part_categories" ADD COLUMN "title_ru" VARCHAR(160);
ALTER TABLE "part_categories" ADD COLUMN "title_uz" VARCHAR(160);
