-- Official Uzbekistan lineups (2026-11-16, owner: add every available model).
-- Each make's source is on its block; details in Backend/docs/vehicle-images/catalog-year-sources.md.
-- Additive only: a row is inserted when its make exists, its id is free (model ids
-- are one global key space) and the make has no model of that name yet. New rows
-- go after the make's existing models; no existing row, make visibility or year
-- range changes. Inactive makes stay inactive (activation is an owner decision).
-- Held, not added: Chevrolet Damas Move & Max (variant or own model?), Leapmotor
-- (no official model list), Tank 300/500/700 (would need a Tank make), Genesis and
-- Skoda beyond the existing rows (no current official Uzbekistan source).

-- kia: kia.uz (official, 2026-11-16)
INSERT INTO "vehicle_models" ("id", "make_id", "name", "sort_order", "body_type", "created_at", "updated_at")
SELECT 'kia-k9', 'kia', 'K9',
       (SELECT COALESCE(MAX("sort_order"), 0) FROM "vehicle_models" WHERE "make_id" = 'kia') + 1,
       'Sedan', NOW(), NOW()
WHERE EXISTS (SELECT 1 FROM "vehicle_makes" WHERE "id" = 'kia')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "id" = 'kia-k9')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "make_id" = 'kia' AND lower("name") = lower('K9'));
INSERT INTO "vehicle_models" ("id", "make_id", "name", "sort_order", "body_type", "created_at", "updated_at")
SELECT 'kia-k8', 'kia', 'K8',
       (SELECT COALESCE(MAX("sort_order"), 0) FROM "vehicle_models" WHERE "make_id" = 'kia') + 1,
       'Sedan', NOW(), NOW()
WHERE EXISTS (SELECT 1 FROM "vehicle_makes" WHERE "id" = 'kia')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "id" = 'kia-k8')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "make_id" = 'kia' AND lower("name") = lower('K8'));
INSERT INTO "vehicle_models" ("id", "make_id", "name", "sort_order", "body_type", "created_at", "updated_at")
SELECT 'kia-k3', 'kia', 'K3',
       (SELECT COALESCE(MAX("sort_order"), 0) FROM "vehicle_models" WHERE "make_id" = 'kia') + 1,
       'Sedan', NOW(), NOW()
WHERE EXISTS (SELECT 1 FROM "vehicle_makes" WHERE "id" = 'kia')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "id" = 'kia-k3')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "make_id" = 'kia' AND lower("name") = lower('K3'));
INSERT INTO "vehicle_models" ("id", "make_id", "name", "sort_order", "body_type", "created_at", "updated_at")
SELECT 'kia-seltos', 'kia', 'Seltos',
       (SELECT COALESCE(MAX("sort_order"), 0) FROM "vehicle_models" WHERE "make_id" = 'kia') + 1,
       'SUV', NOW(), NOW()
WHERE EXISTS (SELECT 1 FROM "vehicle_makes" WHERE "id" = 'kia')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "id" = 'kia-seltos')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "make_id" = 'kia' AND lower("name") = lower('Seltos'));
INSERT INTO "vehicle_models" ("id", "make_id", "name", "sort_order", "body_type", "created_at", "updated_at")
SELECT 'kia-sonet', 'kia', 'Sonet',
       (SELECT COALESCE(MAX("sort_order"), 0) FROM "vehicle_models" WHERE "make_id" = 'kia') + 1,
       'SUV', NOW(), NOW()
WHERE EXISTS (SELECT 1 FROM "vehicle_makes" WHERE "id" = 'kia')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "id" = 'kia-sonet')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "make_id" = 'kia' AND lower("name") = lower('Sonet'));
INSERT INTO "vehicle_models" ("id", "make_id", "name", "sort_order", "body_type", "created_at", "updated_at")
SELECT 'kia-sorento', 'kia', 'Sorento',
       (SELECT COALESCE(MAX("sort_order"), 0) FROM "vehicle_models" WHERE "make_id" = 'kia') + 1,
       'SUV', NOW(), NOW()
WHERE EXISTS (SELECT 1 FROM "vehicle_makes" WHERE "id" = 'kia')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "id" = 'kia-sorento')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "make_id" = 'kia' AND lower("name") = lower('Sorento'));
INSERT INTO "vehicle_models" ("id", "make_id", "name", "sort_order", "body_type", "created_at", "updated_at")
SELECT 'kia-carens', 'kia', 'Carens',
       (SELECT COALESCE(MAX("sort_order"), 0) FROM "vehicle_models" WHERE "make_id" = 'kia') + 1,
       'MPV', NOW(), NOW()
WHERE EXISTS (SELECT 1 FROM "vehicle_makes" WHERE "id" = 'kia')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "id" = 'kia-carens')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "make_id" = 'kia' AND lower("name") = lower('Carens'));
INSERT INTO "vehicle_models" ("id", "make_id", "name", "sort_order", "body_type", "created_at", "updated_at")
SELECT 'kia-carnival', 'kia', 'Carnival',
       (SELECT COALESCE(MAX("sort_order"), 0) FROM "vehicle_models" WHERE "make_id" = 'kia') + 1,
       'Minivan', NOW(), NOW()
WHERE EXISTS (SELECT 1 FROM "vehicle_makes" WHERE "id" = 'kia')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "id" = 'kia-carnival')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "make_id" = 'kia' AND lower("name") = lower('Carnival'));
INSERT INTO "vehicle_models" ("id", "make_id", "name", "sort_order", "body_type", "created_at", "updated_at")
SELECT 'kia-bongo', 'kia', 'Bongo',
       (SELECT COALESCE(MAX("sort_order"), 0) FROM "vehicle_models" WHERE "make_id" = 'kia') + 1,
       'Pickup', NOW(), NOW()
WHERE EXISTS (SELECT 1 FROM "vehicle_makes" WHERE "id" = 'kia')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "id" = 'kia-bongo')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "make_id" = 'kia' AND lower("name") = lower('Bongo'));

-- hyundai: hyundai.uz (official, 2026-11-16)
INSERT INTO "vehicle_models" ("id", "make_id", "name", "sort_order", "body_type", "created_at", "updated_at")
SELECT 'hyundai-elantra', 'hyundai', 'Elantra',
       (SELECT COALESCE(MAX("sort_order"), 0) FROM "vehicle_models" WHERE "make_id" = 'hyundai') + 1,
       'Sedan', NOW(), NOW()
WHERE EXISTS (SELECT 1 FROM "vehicle_makes" WHERE "id" = 'hyundai')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "id" = 'hyundai-elantra')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "make_id" = 'hyundai' AND lower("name") = lower('Elantra'));
INSERT INTO "vehicle_models" ("id", "make_id", "name", "sort_order", "body_type", "created_at", "updated_at")
SELECT 'hyundai-palisade', 'hyundai', 'Palisade',
       (SELECT COALESCE(MAX("sort_order"), 0) FROM "vehicle_models" WHERE "make_id" = 'hyundai') + 1,
       'SUV', NOW(), NOW()
WHERE EXISTS (SELECT 1 FROM "vehicle_makes" WHERE "id" = 'hyundai')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "id" = 'hyundai-palisade')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "make_id" = 'hyundai' AND lower("name") = lower('Palisade'));
INSERT INTO "vehicle_models" ("id", "make_id", "name", "sort_order", "body_type", "created_at", "updated_at")
SELECT 'hyundai-mufasa', 'hyundai', 'Mufasa',
       (SELECT COALESCE(MAX("sort_order"), 0) FROM "vehicle_models" WHERE "make_id" = 'hyundai') + 1,
       'SUV', NOW(), NOW()
WHERE EXISTS (SELECT 1 FROM "vehicle_makes" WHERE "id" = 'hyundai')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "id" = 'hyundai-mufasa')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "make_id" = 'hyundai' AND lower("name") = lower('Mufasa'));
INSERT INTO "vehicle_models" ("id", "make_id", "name", "sort_order", "body_type", "created_at", "updated_at")
SELECT 'hyundai-staria', 'hyundai', 'Staria',
       (SELECT COALESCE(MAX("sort_order"), 0) FROM "vehicle_models" WHERE "make_id" = 'hyundai') + 1,
       'Minivan', NOW(), NOW()
WHERE EXISTS (SELECT 1 FROM "vehicle_makes" WHERE "id" = 'hyundai')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "id" = 'hyundai-staria')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "make_id" = 'hyundai' AND lower("name") = lower('Staria'));

-- haval: gwm.com.uz (official GWM/Haval Uzbekistan, 2026-11-16)
INSERT INTO "vehicle_models" ("id", "make_id", "name", "sort_order", "body_type", "created_at", "updated_at")
SELECT 'haval-h6', 'haval', 'H6',
       (SELECT COALESCE(MAX("sort_order"), 0) FROM "vehicle_models" WHERE "make_id" = 'haval') + 1,
       'SUV', NOW(), NOW()
WHERE EXISTS (SELECT 1 FROM "vehicle_makes" WHERE "id" = 'haval')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "id" = 'haval-h6')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "make_id" = 'haval' AND lower("name") = lower('H6'));
INSERT INTO "vehicle_models" ("id", "make_id", "name", "sort_order", "body_type", "created_at", "updated_at")
SELECT 'haval-h7', 'haval', 'H7',
       (SELECT COALESCE(MAX("sort_order"), 0) FROM "vehicle_models" WHERE "make_id" = 'haval') + 1,
       'SUV', NOW(), NOW()
WHERE EXISTS (SELECT 1 FROM "vehicle_makes" WHERE "id" = 'haval')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "id" = 'haval-h7')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "make_id" = 'haval' AND lower("name") = lower('H7'));
INSERT INTO "vehicle_models" ("id", "make_id", "name", "sort_order", "body_type", "created_at", "updated_at")
SELECT 'haval-h9', 'haval', 'H9',
       (SELECT COALESCE(MAX("sort_order"), 0) FROM "vehicle_models" WHERE "make_id" = 'haval') + 1,
       'SUV', NOW(), NOW()
WHERE EXISTS (SELECT 1 FROM "vehicle_makes" WHERE "id" = 'haval')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "id" = 'haval-h9')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "make_id" = 'haval' AND lower("name") = lower('H9'));
INSERT INTO "vehicle_models" ("id", "make_id", "name", "sort_order", "body_type", "created_at", "updated_at")
SELECT 'haval-jolion', 'haval', 'Jolion',
       (SELECT COALESCE(MAX("sort_order"), 0) FROM "vehicle_models" WHERE "make_id" = 'haval') + 1,
       'SUV', NOW(), NOW()
WHERE EXISTS (SELECT 1 FROM "vehicle_makes" WHERE "id" = 'haval')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "id" = 'haval-jolion')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "make_id" = 'haval' AND lower("name") = lower('Jolion'));
INSERT INTO "vehicle_models" ("id", "make_id", "name", "sort_order", "body_type", "created_at", "updated_at")
SELECT 'haval-m6', 'haval', 'M6',
       (SELECT COALESCE(MAX("sort_order"), 0) FROM "vehicle_models" WHERE "make_id" = 'haval') + 1,
       'SUV', NOW(), NOW()
WHERE EXISTS (SELECT 1 FROM "vehicle_makes" WHERE "id" = 'haval')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "id" = 'haval-m6')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "make_id" = 'haval' AND lower("name") = lower('M6'));

-- toyota: uzbekistan.toyota-centralasia.com (official, 2026-11-16)
INSERT INTO "vehicle_models" ("id", "make_id", "name", "sort_order", "body_type", "created_at", "updated_at")
SELECT 'toyota-camry', 'toyota', 'Camry',
       (SELECT COALESCE(MAX("sort_order"), 0) FROM "vehicle_models" WHERE "make_id" = 'toyota') + 1,
       'Sedan', NOW(), NOW()
WHERE EXISTS (SELECT 1 FROM "vehicle_makes" WHERE "id" = 'toyota')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "id" = 'toyota-camry')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "make_id" = 'toyota' AND lower("name") = lower('Camry'));
INSERT INTO "vehicle_models" ("id", "make_id", "name", "sort_order", "body_type", "created_at", "updated_at")
SELECT 'toyota-rav4', 'toyota', 'RAV4',
       (SELECT COALESCE(MAX("sort_order"), 0) FROM "vehicle_models" WHERE "make_id" = 'toyota') + 1,
       'SUV', NOW(), NOW()
WHERE EXISTS (SELECT 1 FROM "vehicle_makes" WHERE "id" = 'toyota')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "id" = 'toyota-rav4')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "make_id" = 'toyota' AND lower("name") = lower('RAV4'));
INSERT INTO "vehicle_models" ("id", "make_id", "name", "sort_order", "body_type", "created_at", "updated_at")
SELECT 'toyota-land-cruiser-prado', 'toyota', 'Land Cruiser Prado',
       (SELECT COALESCE(MAX("sort_order"), 0) FROM "vehicle_models" WHERE "make_id" = 'toyota') + 1,
       'SUV', NOW(), NOW()
WHERE EXISTS (SELECT 1 FROM "vehicle_makes" WHERE "id" = 'toyota')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "id" = 'toyota-land-cruiser-prado')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "make_id" = 'toyota' AND lower("name") = lower('Land Cruiser Prado'));
INSERT INTO "vehicle_models" ("id", "make_id", "name", "sort_order", "body_type", "created_at", "updated_at")
SELECT 'toyota-land-cruiser-300', 'toyota', 'Land Cruiser 300',
       (SELECT COALESCE(MAX("sort_order"), 0) FROM "vehicle_models" WHERE "make_id" = 'toyota') + 1,
       'SUV', NOW(), NOW()
WHERE EXISTS (SELECT 1 FROM "vehicle_makes" WHERE "id" = 'toyota')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "id" = 'toyota-land-cruiser-300')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "make_id" = 'toyota' AND lower("name") = lower('Land Cruiser 300'));

-- chery: ADM Global (official distributor) lineup: kun.uz 2026-03-05; 2022 launch: Tiggo 4 Pro, Arrizo 6 Pro
INSERT INTO "vehicle_models" ("id", "make_id", "name", "sort_order", "body_type", "created_at", "updated_at")
SELECT 'chery-tiggo-2-pro', 'chery', 'Tiggo 2 Pro',
       (SELECT COALESCE(MAX("sort_order"), 0) FROM "vehicle_models" WHERE "make_id" = 'chery') + 1,
       'SUV', NOW(), NOW()
WHERE EXISTS (SELECT 1 FROM "vehicle_makes" WHERE "id" = 'chery')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "id" = 'chery-tiggo-2-pro')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "make_id" = 'chery' AND lower("name") = lower('Tiggo 2 Pro'));
INSERT INTO "vehicle_models" ("id", "make_id", "name", "sort_order", "body_type", "created_at", "updated_at")
SELECT 'chery-tiggo-4-pro', 'chery', 'Tiggo 4 Pro',
       (SELECT COALESCE(MAX("sort_order"), 0) FROM "vehicle_models" WHERE "make_id" = 'chery') + 1,
       'SUV', NOW(), NOW()
WHERE EXISTS (SELECT 1 FROM "vehicle_makes" WHERE "id" = 'chery')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "id" = 'chery-tiggo-4-pro')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "make_id" = 'chery' AND lower("name") = lower('Tiggo 4 Pro'));
INSERT INTO "vehicle_models" ("id", "make_id", "name", "sort_order", "body_type", "created_at", "updated_at")
SELECT 'chery-arrizo-6-pro', 'chery', 'Arrizo 6 Pro',
       (SELECT COALESCE(MAX("sort_order"), 0) FROM "vehicle_models" WHERE "make_id" = 'chery') + 1,
       'Sedan', NOW(), NOW()
WHERE EXISTS (SELECT 1 FROM "vehicle_makes" WHERE "id" = 'chery')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "id" = 'chery-arrizo-6-pro')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "make_id" = 'chery' AND lower("name") = lower('Arrizo 6 Pro'));
INSERT INTO "vehicle_models" ("id", "make_id", "name", "sort_order", "body_type", "created_at", "updated_at")
SELECT 'chery-arrizo-8', 'chery', 'Arrizo 8',
       (SELECT COALESCE(MAX("sort_order"), 0) FROM "vehicle_models" WHERE "make_id" = 'chery') + 1,
       'Sedan', NOW(), NOW()
WHERE EXISTS (SELECT 1 FROM "vehicle_makes" WHERE "id" = 'chery')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "id" = 'chery-arrizo-8')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "make_id" = 'chery' AND lower("name") = lower('Arrizo 8'));

-- byd: CnEVPost 2026-10-08: Fang Cheng Bao Tai 7 on sale in Uzbekistan as BYD Ti 7
INSERT INTO "vehicle_models" ("id", "make_id", "name", "sort_order", "body_type", "created_at", "updated_at")
SELECT 'byd-ti-7', 'byd', 'Ti 7',
       (SELECT COALESCE(MAX("sort_order"), 0) FROM "vehicle_models" WHERE "make_id" = 'byd') + 1,
       'SUV', NOW(), NOW()
WHERE EXISTS (SELECT 1 FROM "vehicle_makes" WHERE "id" = 'byd')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "id" = 'byd-ti-7')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "make_id" = 'byd' AND lower("name") = lower('Ti 7'));

-- volkswagen: volkswagen.uz/ru/models.html (official, 2026-11-16)
INSERT INTO "vehicle_models" ("id", "make_id", "name", "sort_order", "body_type", "created_at", "updated_at")
SELECT 'teramont-x', 'volkswagen', 'Teramont X',
       (SELECT COALESCE(MAX("sort_order"), 0) FROM "vehicle_models" WHERE "make_id" = 'volkswagen') + 1,
       'SUV', NOW(), NOW()
WHERE EXISTS (SELECT 1 FROM "vehicle_makes" WHERE "id" = 'volkswagen')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "id" = 'teramont-x')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "make_id" = 'volkswagen' AND lower("name") = lower('Teramont X'));

-- lada: AvtoVAZ/Roodell: Vesta, Largus, XRay assembled at ADM Jizzakh from 2021 (kun.uz 2021-10-16)
INSERT INTO "vehicle_models" ("id", "make_id", "name", "sort_order", "body_type", "created_at", "updated_at")
SELECT 'lada-vesta', 'lada', 'Vesta',
       (SELECT COALESCE(MAX("sort_order"), 0) FROM "vehicle_models" WHERE "make_id" = 'lada') + 1,
       'Sedan', NOW(), NOW()
WHERE EXISTS (SELECT 1 FROM "vehicle_makes" WHERE "id" = 'lada')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "id" = 'lada-vesta')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "make_id" = 'lada' AND lower("name") = lower('Vesta'));
INSERT INTO "vehicle_models" ("id", "make_id", "name", "sort_order", "body_type", "created_at", "updated_at")
SELECT 'lada-largus', 'lada', 'Largus',
       (SELECT COALESCE(MAX("sort_order"), 0) FROM "vehicle_models" WHERE "make_id" = 'lada') + 1,
       'Wagon', NOW(), NOW()
WHERE EXISTS (SELECT 1 FROM "vehicle_makes" WHERE "id" = 'lada')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "id" = 'lada-largus')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "make_id" = 'lada' AND lower("name") = lower('Largus'));
INSERT INTO "vehicle_models" ("id", "make_id", "name", "sort_order", "body_type", "created_at", "updated_at")
SELECT 'lada-xray', 'lada', 'XRay',
       (SELECT COALESCE(MAX("sort_order"), 0) FROM "vehicle_models" WHERE "make_id" = 'lada') + 1,
       'Hatchback', NOW(), NOW()
WHERE EXISTS (SELECT 1 FROM "vehicle_makes" WHERE "id" = 'lada')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "id" = 'lada-xray')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "make_id" = 'lada' AND lower("name") = lower('XRay'));

-- ssangyong: spot.uz 2023-02-15: Uzbekistan lineup Rexton, Musso, Korando, Torres, XLV, Tivoli
INSERT INTO "vehicle_models" ("id", "make_id", "name", "sort_order", "body_type", "created_at", "updated_at")
SELECT 'tivoli', 'ssangyong', 'Tivoli',
       (SELECT COALESCE(MAX("sort_order"), 0) FROM "vehicle_models" WHERE "make_id" = 'ssangyong') + 1,
       'SUV', NOW(), NOW()
WHERE EXISTS (SELECT 1 FROM "vehicle_makes" WHERE "id" = 'ssangyong')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "id" = 'tivoli')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "make_id" = 'ssangyong' AND lower("name") = lower('Tivoli'));
INSERT INTO "vehicle_models" ("id", "make_id", "name", "sort_order", "body_type", "created_at", "updated_at")
SELECT 'xlv', 'ssangyong', 'XLV',
       (SELECT COALESCE(MAX("sort_order"), 0) FROM "vehicle_models" WHERE "make_id" = 'ssangyong') + 1,
       'SUV', NOW(), NOW()
WHERE EXISTS (SELECT 1 FROM "vehicle_makes" WHERE "id" = 'ssangyong')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "id" = 'xlv')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "make_id" = 'ssangyong' AND lower("name") = lower('XLV'));

-- nissan: spot.uz 2024-07-27: Nissan Uzbekistan showroom sells the Patrol
INSERT INTO "vehicle_models" ("id", "make_id", "name", "sort_order", "body_type", "created_at", "updated_at")
SELECT 'nissan-patrol', 'nissan', 'Patrol',
       (SELECT COALESCE(MAX("sort_order"), 0) FROM "vehicle_models" WHERE "make_id" = 'nissan') + 1,
       'SUV', NOW(), NOW()
WHERE EXISTS (SELECT 1 FROM "vehicle_makes" WHERE "id" = 'nissan')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "id" = 'nissan-patrol')
  AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "make_id" = 'nissan' AND lower("name") = lower('Patrol'));
