# Архитектурный чекпоинт — «Check If It Fits» (применяемость детали к авто)

> Дата аудита: 2026-07-30. Охват: `mator.uz/Backend` (NestJS+Prisma) · `matorui`
> (Expo mobile) · `mator-admin` (Next.js). Метод: read-only разбор кода, ключевые
> факты верифицированы по файлам (пути и строки указаны). Это снимок; строки могут
> сдвинуться при последующих правках.

## Вердикт одной строкой

Движок совместимости **на бэкенде реально существует и на ~60–70% рабочий**, но не
дотягивает до спецификации по контракту и по 2 из 3 сценариев. **Мобильное
приложение почти не подключено** (показывает «зелёный» статус без реальной
проверки — ложное «100% подходит»). **В админке управления применимостью нет
вообще** — данные, на которых держится фича, операторам вводить нечем.

## Статус по цепочке

| Слой | Что есть | Вердикт |
|---|---|---|
| **Backend** (`mator.uz/Backend`) | Эндпоинт, `isUniversal`, `VehicleModelRef`, trim/engine-матчинг, фильтрация каталога по авто | 🟡 PARTIAL |
| **Mobile** (`matorui`) | Гараж/активное авто с полным фитментом; «зелёная» плашка | 🔴 в основном не подключено |
| **Admin** (`mator-admin`) | — | 🔴 отсутствует полностью |

---

## 1. Три сценария проверки (Compatibility Logic)

| Сценарий | Спека | Реальность (backend) | Статус |
|---|---|---|---|
| **Direct Model Match** → `GREEN / FIT_GUARANTEED` | по make/model/**generation**/**engineVolume**/year | Матчинг по `PartCompatibility.trimId + years` (trim) и `engineId`; engine-матч даунгрейдится до `maybe`. Есть, но по **trim/engine**, а не по generation/engineVolume | 🟡 PARTIAL |
| **Universal** → `GREEN / UNIVERSAL_FIT` | `isUniversal` → зелёный; **исключение**: масла с допусками (VW 504.00 / 5W-30) сверяются с сервисной книжкой авто | `isUniversal → status:'fits', source:'universal'` работает. **Исключения по маслам НЕТ** — у авто негде хранить требуемый допуск/вязкость | 🟡 PARTIAL |
| **VIN Lookup / OEM Cross-Match** → `GREEN / OEM_MATCH` | 17-знач. VIN → OEM оригинала → сверка с OEM/кросс-номерами детали | **НЕ реализовано.** `Vehicle.vin` хранится, но нигде не декодируется. Таблица `OemCompatibility` есть, но в `compatibility()` **не запрашивается** (используется только при Telegram-ингесте) | 🔴 MISSING |

**Файлы:**
- Логика: `src/catalog/parts/parts.service.ts:114-157` (метод `compatibility`), `src/catalog/parts/part.presenter.ts:42-80` (`computeCompatibility`).
- `isUniversal` шорткат: `parts.service.ts:128`.

---

## 2. Контракт API — расхождение со спецификацией

**Ожидалось (спека):** `POST /v1/products/:id/check-compatibility` + body `{ vehicleId | vin }`.

**Фактически:** `GET /v1/catalog/parts/:id/compatibility?vehicle_id=` — `src/catalog/parts/parts.controller.ts:37-43`. GET, query-параметр, **без body и без поддержки VIN**.

| Поле спеки | Реальность |
|---|---|
| `status: EXACT_MATCH \| UNIVERSAL \| NOT_COMPATIBLE \| UNCERTAIN` | `status: fits \| maybe \| does_not_fit` (нижний регистр) |
| `isCompatible: boolean` | отсутствует |
| `badge { text, color }` | отсутствует |
| `details { matchedBy, oemNumber }` | отсутствует |

**Фактический ответ:**
```json
{ "part_id": "...", "vehicle_id": "...", "status": "fits|maybe|does_not_fit",
  "confidence": 0.0, "matched_trims": [], "matched_engines": [], "source": "universal|null" }
```

### Схема Prisma (`prisma/schema.prisma`)
- ✅ `isUniversal` (Product `:372`), `oemNumber` (`:363`), `oilViscosity`/`oilType` (`:390-391`).
- ✅ `VehicleModelRef` (`:740`), `PartCompatibility` (FITS/MAYBE/DOES_NOT_FIT), `PartModel`, `CatalogPartFit`, `OemCompatibility` (`:439`).
- 🔴 `VehicleModelRef` **без `generation` и `engineVolume`** (есть только `yearFrom/yearTo/bodyType`).
- 🔴 **Нет хранилища сервисного допуска/вязкости масла на стороне авто** — сверять требования не с чем.

---

## 3. Frontend (Mobile, `matorui`)

- 🔴 **Нет вызова эндпоинта совместимости.** Клиент никогда не дёргает `/compatibility`. Активное авто (`contexts/active-vehicle.context.tsx`) используется только для контекста **поиска**, не для проверки детали.
- ⚠️ **Опасно (P0):** в карточке товара (`components/screens/item-detail-screen.tsx:197-212`) плашка **«✓ Confirmed fit» показывается безусловно**, как только в гараже есть авто — **без единой проверки**. Ложное «100% подходит» прямо противоречит цели фичи (снижение возвратов).
- 🔴 Нет статусов RED «Не подходит» + «показать аналоги» и YELLOW «Требуется уточнение VIN».
- 🔴 **Safety Gate в корзине отсутствует** — `addToCart` (`item-detail-screen.tsx:86`) добавляет без предупреждения; поле `CartItem.status` есть, но не используется.
- ✅ Гараж/фитмент смоделирован полноценно: `brandId/modelId/generationId/trimId/engineId/vin` (`services/garage-service.ts`). Плумбинг для фичи готов.
- ℹ️ Мок `check_fitment` в AI-чате (`services/chat-api.ts:104`) возвращает статичный «Compatible» — не реальная проверка.

---

## 4. Admin (`mator-admin`)

Управления применимостью **нет**. Инвентарь редактирует только `purchasePrice / retailPrice / cashbackPct / stock` (`src/types/catalog-admin.ts`, `src/lib/inventory-api.ts`).

**Отсутствуют поля:** `isUniversal`, привязка к моделям авто (`VehicleModelRef`), редактирование OEM/кросс-номеров (`oem` — только read-only), допуски масел. Категорийная «универсальность» тоже отсутствует (иконка «oils» — чисто визуальная, логику не задаёт). Итог: **операторам нечем наполнять** данные фичи.

---

## ✅ Что уже работает корректно

1. Эндпоинт + сервис совместимости (trim/engine-матчинг, confidence, downgrade engine→`maybe`).
2. `isUniversal` → мгновенный `fits` (масла/химия) — `parts.service.ts:128`.
3. Серверная фильтрация каталога по `vehicle_id` (универсальные всегда видны, `does_not_fit` отсекаются).
4. Полная модель гаража/фитмента в мобилке.

## 🔧 Что дописать / поправить (по приоритету)

**P0 — убрать ложный «зелёный» (быстро, снижает риск сейчас).**
Мобилка: не показывать «Confirmed fit» без ответа эндпоинта. Либо скрыть плашку, либо реально вызвать `/compatibility` и рендерить green/red/yellow по `status`.

**P1 — довести контракт до спеки (backend, обратно совместимо).**
Добавить в ответ `isCompatible`, `badge{text,color}`, `details{matchedBy, oemNumber}` и маппинг `fits→EXACT_MATCH/UNIVERSAL`, `does_not_fit→NOT_COMPATIBLE`, `maybe→UNCERTAIN`. Принять `{ vin }` как альтернативу `vehicle_id`. Можно новым `POST /check-compatibility` рядом, старый GET не ломать.

**P2 — VIN/OEM cross-match (сценарий 3).**
Задействовать `OemCompatibility` в `compatibility()`; добавить VIN→OEM резолв. Сейчас таблица есть, но для покупателя мёртвая.

**P3 — админка (иначе данные некому вводить).**
Форма детали: `isUniversal`, привязка к `VehicleModelRef`, OEM/кросс-номера, допуски масла + соответствующие поля в inventory API/типах.

**P4 — исключение по маслам.**
Добавить на авто хранилище требуемого допуска/вязкости и сверку с `oilViscosity/oilType`. Требует расширения схемы (`VehicleModelRef.generation`, `engineVolume` + oil-spec) — самый крупный кусок.

**P5 — Safety Gate в корзине.**
Проверка `status === NOT_COMPATIBLE` перед `addItem` + диалог «Внимание! Деталь не подходит под выбранную машину. Вы уверены?».

---

## Приложение — карта файлов

| Область | Файл |
|---|---|
| Роут эндпоинта | `src/catalog/parts/parts.controller.ts:37` |
| Логика совместимости | `src/catalog/parts/parts.service.ts:114`, `src/catalog/parts/part.presenter.ts:42` |
| Prisma-модели | `prisma/schema.prisma` — `Product:350`, `OemCompatibility:439`, `VehicleModelRef:740`, `PartCompatibility` |
| Mobile: карточка/плашка | `matorui/components/screens/item-detail-screen.tsx:197`, `:86` (addToCart) |
| Mobile: активное авто/гараж | `matorui/contexts/active-vehicle.context.tsx`, `matorui/services/garage-service.ts` |
| Admin: инвентарь | `mator-admin/src/types/catalog-admin.ts`, `mator-admin/src/lib/inventory-api.ts` |
