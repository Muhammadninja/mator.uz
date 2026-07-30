export const DOMAINS = [
  { id: "identity", label: "Identity & Garage", color: "#3b82f6", note: "Who is buying, where they ship, what they drive." },
  { id: "catalog", label: "Catalog & Inventory", color: "#8b5cf6", note: "Master parts, dealer listings, stock and media." },
  { id: "fitment", label: "Vehicle & Fitment", color: "#06b6d4", note: "Powers the 3D Fitment Studio and “Check if it fits”." },
  { id: "commerce", label: "Commerce", color: "#22c55e", note: "Cart → order → payment → shipment → refund." },
  { id: "engagement", label: "Engagement", color: "#f59e0b", note: "Reviews, favorites, AI chat, promotions." },
  { id: "platform", label: "Platform & Audit", color: "#ef4444", note: "Staff accounts, permissions, settings, audit trail." }
];

export const TABLES = [
  { d: "identity", name: "users", desc: "Buyer account. Guest-first: a row is created lazily on first auth.", cols: [
    ["PK", "id", "uuid", "gen_random_uuid()"], ["", "phone", "text", "unique, E.164 (+998…)"], ["", "email", "text", "nullable, unique"],
    ["", "full_name", "text", "nullable"], ["", "locale", "locale_code", "ru | en | uz"], ["", "status", "user_status", "active | blocked"],
    ["", "created_at", "timestamptz", "now()"], ["", "last_seen_at", "timestamptz", "nullable"]] },
  { d: "identity", name: "user_sessions", desc: "Refresh tokens per device; revoked on logout.", cols: [
    ["PK", "id", "uuid", ""], ["FK", "user_id", "uuid", "→ users.id"], ["", "device", "text", "UA fingerprint"],
    ["", "refresh_token_hash", "text", "sha256"], ["", "expires_at", "timestamptz", ""], ["", "revoked_at", "timestamptz", "nullable"]] },
  { d: "identity", name: "addresses", desc: "Shipping addresses reused at checkout.", cols: [
    ["PK", "id", "uuid", ""], ["FK", "user_id", "uuid", "→ users.id"], ["", "label", "text", "Home / Work"],
    ["", "region", "text", "Tashkent, Samarqand…"], ["", "line1", "text", ""], ["", "landmark", "text", "nullable"],
    ["", "geo", "point", "nullable, courier hint"], ["", "is_default", "boolean", "false"]] },
  { d: "identity", name: "garage_vehicles", desc: "A user's saved cars. Drives fitment checks across the app.", cols: [
    ["PK", "id", "uuid", ""], ["FK", "user_id", "uuid", "→ users.id"], ["FK", "trim_id", "uuid", "→ vehicle_trims.id"],
    ["", "nickname", "text", "“Oq Lacetti”"], ["", "vin", "char(17)", "nullable, unique per user"], ["", "plate", "text", "nullable"],
    ["", "year", "smallint", "check 1980–2030"], ["", "mileage_km", "integer", "nullable"], ["", "is_primary", "boolean", "one true per user"]] },

  { d: "catalog", name: "dealers", desc: "Seller storefront. MATOR Certified is a flag here.", cols: [
    ["PK", "id", "uuid", ""], ["", "name", "text", ""], ["", "slug", "text", "unique"], ["", "region", "text", ""],
    ["", "status", "dealer_status", "pending | active | suspended"], ["", "is_certified", "boolean", "false"],
    ["", "has_lowest_price", "boolean", "false"], ["", "commission_bps", "smallint", "default 700 (7%)"],
    ["", "gmv_cents", "bigint", "materialized nightly"], ["", "joined_at", "timestamptz", ""]] },
  { d: "catalog", name: "categories", desc: "Self-referencing tree behind the colorful category grid.", cols: [
    ["PK", "id", "uuid", ""], ["FK", "parent_id", "uuid", "→ categories.id, nullable"], ["", "slug", "text", "unique"],
    ["", "name_i18n", "jsonb", "{ ru, en, uz }"], ["", "icon_key", "text", "SVG asset key"],
    ["", "accent_hex", "char(7)", "grid tile color"], ["", "sort_order", "smallint", ""]] },
  { d: "catalog", name: "brands", desc: "Part manufacturers: BOSCH, Sangsin, ACDelco…", cols: [
    ["PK", "id", "uuid", ""], ["", "name", "text", "unique"], ["", "country", "char(2)", "nullable"],
    ["", "tier", "brand_tier", "oem | aftermarket"], ["", "logo_url", "text", "nullable"]] },
  { d: "catalog", name: "parts", desc: "Master SKU — brand-level truth, independent of any dealer.", cols: [
    ["PK", "id", "uuid", ""], ["FK", "brand_id", "uuid", "→ brands.id"], ["FK", "category_id", "uuid", "→ categories.id"],
    ["", "sku", "text", "unique per brand"], ["", "name_i18n", "jsonb", "{ ru, en, uz }"], ["", "spec", "jsonb", "dimensions, material…"],
    ["", "is_universal", "boolean", "skips fitment checks"], ["", "status", "part_status", "draft | live | archived"]] },
  { d: "catalog", name: "part_media", desc: "Ordered images per master part.", cols: [
    ["PK", "id", "uuid", ""], ["FK", "part_id", "uuid", "→ parts.id"], ["", "url", "text", ""],
    ["", "kind", "media_kind", "photo | diagram | box"], ["", "sort_order", "smallint", ""]] },
  { d: "catalog", name: "listings", desc: "A dealer's offer of a part: price, stock, moderation state.", cols: [
    ["PK", "id", "uuid", ""], ["FK", "part_id", "uuid", "→ parts.id"], ["FK", "dealer_id", "uuid", "→ dealers.id"],
    ["", "price_cents", "bigint", "UZS, integer only"], ["", "compare_at_cents", "bigint", "nullable → savings badge"],
    ["", "condition", "listing_condition", "new | refurbished | used"], ["", "warranty_months", "smallint", "0"],
    ["", "status", "listing_status", "pending | live | rejected | paused"], ["UQ", "(part_id, dealer_id)", "", "one offer per dealer"]] },
  { d: "catalog", name: "inventory", desc: "Stock per listing per warehouse; reserved on checkout.", cols: [
    ["PK", "id", "uuid", ""], ["FK", "listing_id", "uuid", "→ listings.id"], ["", "warehouse", "text", "Tashkent-1"],
    ["", "on_hand", "integer", "check ≥ 0"], ["", "reserved", "integer", "check ≥ 0"], ["", "restock_eta", "date", "nullable"]] },

  { d: "fitment", name: "vehicle_makes", desc: "Chevrolet, Ravon, Daewoo… seeds the Shop-by-vehicle row.", cols: [
    ["PK", "id", "uuid", ""], ["", "name", "text", "unique"], ["", "logo_url", "text", "nullable"], ["", "popularity", "smallint", "UZ market ordering"]] },
  { d: "fitment", name: "vehicle_models", desc: "Lacetti, Cobalt, Gentra, Tracker, Damas, Nexia…", cols: [
    ["PK", "id", "uuid", ""], ["FK", "make_id", "uuid", "→ vehicle_makes.id"], ["", "name", "text", ""],
    ["", "body_type", "body_type", "sedan | hatch | suv | van"], ["", "silhouette_key", "text", "SVG/GLB asset key"], ["UQ", "(make_id, name)", "", ""]] },
  { d: "fitment", name: "vehicle_trims", desc: "The bindable unit: engine + platform + year range (“1.5L J200 2013–2024”).", cols: [
    ["PK", "id", "uuid", ""], ["FK", "model_id", "uuid", "→ vehicle_models.id"], ["", "engine_code", "text", "J200 / T250"],
    ["", "displacement_l", "numeric(2,1)", "1.5"], ["", "year_from", "smallint", ""], ["", "year_to", "smallint", "nullable = present"],
    ["", "gearbox", "gearbox_type", "mt | at | cvt"], ["", "model_glb_url", "text", "3D mesh for the studio"]] },
  { d: "fitment", name: "anatomy_nodes", desc: "The 7 hotspots on the 3D car. World-space coords live here.", cols: [
    ["PK", "id", "uuid", ""], ["", "key", "node_key", "engine | front_brakes | …"], ["", "label_i18n", "jsonb", "{ ru, en, uz }"],
    ["FK", "category_id", "uuid", "→ categories.id, default filter"], ["", "pos_x", "numeric(4,2)", "-0.86"],
    ["", "pos_y", "numeric(4,2)", "0.34"], ["", "pos_z", "numeric(4,2)", "1.30"], ["", "sort_order", "smallint", ""]] },
  { d: "fitment", name: "trim_node_state", desc: "Per-trim mapping progress → node color and the fitment % bar.", cols: [
    ["PK", "id", "uuid", ""], ["FK", "trim_id", "uuid", "→ vehicle_trims.id"], ["FK", "node_id", "uuid", "→ anatomy_nodes.id"],
    ["", "verified", "boolean", "false → yellow"], ["", "verified_source", "verify_source", "vin | universal | import"],
    ["FK", "verified_by", "uuid", "→ admin_users.id, nullable"], ["UQ", "(trim_id, node_id)", "", ""]] },
  { d: "fitment", name: "fitment_links", desc: "Part ⇄ trim ⇄ node. The core many-to-many of the whole platform.", cols: [
    ["PK", "id", "uuid", ""], ["FK", "part_id", "uuid", "→ parts.id"], ["FK", "trim_id", "uuid", "→ vehicle_trims.id"],
    ["FK", "node_id", "uuid", "→ anatomy_nodes.id"], ["", "position", "fit_position", "front | rear | left | right | any"],
    ["", "confidence", "fit_confidence", "confirmed | probable | unverified"], ["", "source", "fit_source", "manual | copy | ai | import"],
    ["FK", "created_by", "uuid", "→ admin_users.id"], ["UQ", "(part_id, trim_id, node_id, position)", "", ""]] },
  { d: "fitment", name: "oem_cross_refs", desc: "OEM number graph feeding the AI cross-reference banner.", cols: [
    ["PK", "id", "uuid", ""], ["FK", "part_id", "uuid", "→ parts.id"], ["", "oem_number", "text", "GM 96484900"],
    ["", "oem_brand", "text", "GM / Daewoo"], ["", "confidence", "numeric(3,2)", "0.00–1.00"], ["IDX", "oem_number", "", "trigram + btree"]] },
  { d: "fitment", name: "fitment_imports", desc: "CSV/TecDoc batch runs, kept for rollback.", cols: [
    ["PK", "id", "uuid", ""], ["FK", "uploaded_by", "uuid", "→ admin_users.id"], ["", "filename", "text", ""],
    ["", "rows_total", "integer", ""], ["", "rows_applied", "integer", ""],
    ["", "status", "import_status", "queued | running | done | failed"], ["", "error_log", "jsonb", "nullable"]] },

  { d: "commerce", name: "carts", desc: "One open cart per user; guests get a device-scoped cart.", cols: [
    ["PK", "id", "uuid", ""], ["FK", "user_id", "uuid", "→ users.id, nullable (guest)"], ["", "device_key", "text", "nullable, guest merge key"],
    ["FK", "vehicle_id", "uuid", "→ garage_vehicles.id, fit context"], ["", "status", "cart_status", "open | converted | abandoned"]] },
  { d: "commerce", name: "cart_items", desc: "Price is re-validated at checkout, never trusted from the client.", cols: [
    ["PK", "id", "uuid", ""], ["FK", "cart_id", "uuid", "→ carts.id"], ["FK", "listing_id", "uuid", "→ listings.id"],
    ["", "qty", "smallint", "check > 0"], ["", "fit_state", "fit_state", "fits | unknown | does_not_fit"], ["UQ", "(cart_id, listing_id)", "", ""]] },
  { d: "commerce", name: "orders", desc: "Immutable header. Money is stored in integer UZS cents.", cols: [
    ["PK", "id", "uuid", ""], ["", "number", "text", "unique, MTR-24-000142"], ["FK", "user_id", "uuid", "→ users.id"],
    ["FK", "address_id", "uuid", "→ addresses.id"], ["", "status", "order_status", "processing → delivered"],
    ["", "subtotal_cents", "bigint", ""], ["", "delivery_cents", "bigint", ""], ["", "discount_cents", "bigint", "0"],
    ["", "total_cents", "bigint", "generated"], ["", "placed_at", "timestamptz", ""]] },
  { d: "commerce", name: "order_items", desc: "Snapshot of the listing at purchase time — never joins for price.", cols: [
    ["PK", "id", "uuid", ""], ["FK", "order_id", "uuid", "→ orders.id"], ["FK", "listing_id", "uuid", "→ listings.id, nullable"],
    ["FK", "dealer_id", "uuid", "→ dealers.id"], ["", "part_name", "text", "frozen copy"], ["", "sku", "text", "frozen copy"],
    ["", "unit_price_cents", "bigint", "frozen"], ["", "qty", "smallint", ""], ["", "commission_cents", "bigint", "at order time"]] },
  { d: "commerce", name: "payments", desc: "Payme / Click / Uzum / cash-on-delivery attempts.", cols: [
    ["PK", "id", "uuid", ""], ["FK", "order_id", "uuid", "→ orders.id"], ["", "provider", "payment_provider", "payme | click | uzum | cod"],
    ["", "provider_ref", "text", "nullable, unique"], ["", "amount_cents", "bigint", ""],
    ["", "status", "payment_status", "pending | paid | failed"], ["", "paid_at", "timestamptz", "nullable"]] },
  { d: "commerce", name: "shipments", desc: "One per dealer per order — split shipments are normal.", cols: [
    ["PK", "id", "uuid", ""], ["FK", "order_id", "uuid", "→ orders.id"], ["FK", "dealer_id", "uuid", "→ dealers.id"],
    ["", "carrier", "text", "nullable"], ["", "tracking_code", "text", "nullable"],
    ["", "status", "shipment_status", "packing → delivered"], ["", "eta", "date", "nullable"]] },
  { d: "commerce", name: "shipment_events", desc: "Append-only timeline powering the tracking screen.", cols: [
    ["PK", "id", "uuid", ""], ["FK", "shipment_id", "uuid", "→ shipments.id"], ["", "state", "shipment_status", ""],
    ["", "note_i18n", "jsonb", "nullable"], ["", "occurred_at", "timestamptz", ""]] },
  { d: "commerce", name: "refunds", desc: "Partial refunds allowed; sum is checked against the order total.", cols: [
    ["PK", "id", "uuid", ""], ["FK", "order_id", "uuid", "→ orders.id"], ["FK", "issued_by", "uuid", "→ admin_users.id"],
    ["", "amount_cents", "bigint", ""], ["", "reason", "refund_reason", "wrong_fit | damaged | late | other"],
    ["", "status", "refund_status", "requested | approved | paid | denied"]] },

  { d: "engagement", name: "reviews", desc: "One review per user per order item; drives the row rating.", cols: [
    ["PK", "id", "uuid", ""], ["FK", "user_id", "uuid", "→ users.id"], ["FK", "part_id", "uuid", "→ parts.id"],
    ["FK", "order_item_id", "uuid", "→ order_items.id, verified badge"], ["", "rating", "smallint", "check 1–5"],
    ["", "body", "text", "nullable"], ["", "status", "moderation_status", "pending | published | hidden"], ["UQ", "(user_id, order_item_id)", "", ""]] },
  { d: "engagement", name: "favorites", desc: "Saved parts. Composite PK, no surrogate id.", cols: [
    ["PK", "user_id", "uuid", "→ users.id"], ["PK", "part_id", "uuid", "→ parts.id"], ["", "created_at", "timestamptz", "now()"]] },
  { d: "engagement", name: "chat_threads", desc: "AI assistant conversations, optionally scoped to a car.", cols: [
    ["PK", "id", "uuid", ""], ["FK", "user_id", "uuid", "→ users.id"], ["FK", "vehicle_id", "uuid", "→ garage_vehicles.id, nullable"],
    ["", "title", "text", "auto-summarized"], ["", "last_message_at", "timestamptz", ""]] },
  { d: "engagement", name: "chat_messages", desc: "Role-tagged turns; tool calls stored as jsonb.", cols: [
    ["PK", "id", "uuid", ""], ["FK", "thread_id", "uuid", "→ chat_threads.id"], ["", "role", "chat_role", "user | assistant | system"],
    ["", "content", "text", ""], ["", "tool_payload", "jsonb", "nullable"], ["", "created_at", "timestamptz", ""]] },
  { d: "engagement", name: "promotions", desc: "Campaign + code. Scope is a jsonb rule set.", cols: [
    ["PK", "id", "uuid", ""], ["", "code", "text", "unique, nullable (auto promo)"], ["", "kind", "promo_kind", "percent | fixed | free_delivery"],
    ["", "value", "integer", "bps or cents"], ["", "scope", "jsonb", "{ categories[], dealers[] }"],
    ["", "starts_at", "timestamptz", ""], ["", "ends_at", "timestamptz", ""]] },

  { d: "platform", name: "admin_users", desc: "Staff logins for the admin panel and Fitment Studio.", cols: [
    ["PK", "id", "uuid", ""], ["", "email", "text", "unique"], ["", "full_name", "text", ""],
    ["FK", "dealer_id", "uuid", "→ dealers.id, nullable (dealer staff)"], ["", "status", "admin_status", "active | invited | disabled"],
    ["", "last_login_at", "timestamptz", "nullable"]] },
  { d: "platform", name: "admin_roles", desc: "super_admin, ops, catalog, read_only. Permissions as jsonb.", cols: [
    ["PK", "id", "uuid", ""], ["", "key", "admin_role", "unique"], ["", "permissions", "jsonb", "{ orders:'rw', settings:'r' }"]] },
  { d: "platform", name: "admin_user_roles", desc: "Join table — a user may hold several roles.", cols: [
    ["PK", "admin_user_id", "uuid", "→ admin_users.id"], ["PK", "role_id", "uuid", "→ admin_roles.id"], ["", "granted_at", "timestamptz", "now()"]] },
  { d: "platform", name: "audit_log", desc: "Every mutating admin action. Never updated, never deleted.", cols: [
    ["PK", "id", "bigserial", ""], ["FK", "actor_id", "uuid", "→ admin_users.id"], ["", "action", "text", "fitment.bind"],
    ["", "entity", "text", "fitment_links"], ["", "entity_id", "uuid", "nullable"], ["", "diff", "jsonb", "before / after"],
    ["", "ip", "inet", ""], ["", "created_at", "timestamptz", "now(), IDX brin"]] },
  { d: "platform", name: "settings", desc: "Single-row-per-key config: commission, moderation rules, feature flags.", cols: [
    ["PK", "key", "text", ""], ["", "value", "jsonb", ""], ["FK", "updated_by", "uuid", "→ admin_users.id"], ["", "updated_at", "timestamptz", ""]] }
];

// parent, cardinality, child, foreign key (or join table), on delete
export const RELATIONS = [
  ["users", "1 : N", "user_sessions", "user_id", "cascade"],
  ["users", "1 : N", "garage_vehicles", "user_id", "cascade"],
  ["users", "1 : N", "addresses", "user_id", "cascade"],
  ["users", "1 : N", "orders", "user_id", "restrict"],
  ["users", "1 : N", "carts", "user_id", "cascade"],
  ["addresses", "1 : N", "orders", "address_id", "restrict"],
  ["vehicle_makes", "1 : N", "vehicle_models", "make_id", "restrict"],
  ["vehicle_models", "1 : N", "vehicle_trims", "model_id", "restrict"],
  ["vehicle_trims", "1 : N", "garage_vehicles", "trim_id", "restrict"],
  ["vehicle_trims", "1 : N", "trim_node_state", "trim_id", "cascade"],
  ["anatomy_nodes", "1 : N", "trim_node_state", "node_id", "restrict"],
  ["vehicle_trims", "1 : N", "fitment_links", "trim_id", "cascade"],
  ["anatomy_nodes", "1 : N", "fitment_links", "node_id", "restrict"],
  ["parts", "1 : N", "fitment_links", "part_id", "cascade"],
  ["categories", "1 : N", "anatomy_nodes", "category_id", "restrict"],
  ["parts", "1 : N", "oem_cross_refs", "part_id", "cascade"],
  ["admin_users", "1 : N", "fitment_imports", "uploaded_by", "restrict"],
  ["brands", "1 : N", "parts", "brand_id", "restrict"],
  ["categories", "1 : N", "categories", "parent_id", "restrict"],
  ["categories", "1 : N", "parts", "category_id", "restrict"],
  ["parts", "1 : N", "part_media", "part_id", "cascade"],
  ["parts", "1 : N", "listings", "part_id", "cascade"],
  ["dealers", "1 : N", "listings", "dealer_id", "restrict"],
  ["listings", "1 : 1", "inventory", "listing_id", "cascade"],
  ["carts", "1 : N", "cart_items", "cart_id", "cascade"],
  ["listings", "1 : N", "cart_items", "listing_id", "cascade"],
  ["garage_vehicles", "1 : N", "carts", "vehicle_id", "set null"],
  ["orders", "1 : N", "order_items", "order_id", "restrict"],
  ["listings", "1 : N", "order_items", "listing_id", "set null"],
  ["dealers", "1 : N", "order_items", "dealer_id", "restrict"],
  ["orders", "1 : N", "payments", "order_id", "restrict"],
  ["orders", "1 : N", "shipments", "order_id", "restrict"],
  ["dealers", "1 : N", "shipments", "dealer_id", "restrict"],
  ["shipments", "1 : N", "shipment_events", "shipment_id", "cascade"],
  ["orders", "1 : N", "refunds", "order_id", "restrict"],
  ["admin_users", "1 : N", "refunds", "issued_by", "restrict"],
  ["users", "1 : N", "reviews", "user_id", "cascade"],
  ["parts", "1 : N", "reviews", "part_id", "cascade"],
  ["order_items", "1 : 1", "reviews", "order_item_id", "set null"],
  ["users", "1 : N", "favorites", "user_id", "cascade"],
  ["parts", "1 : N", "favorites", "part_id", "cascade"],
  ["users", "1 : N", "chat_threads", "user_id", "cascade"],
  ["garage_vehicles", "1 : N", "chat_threads", "vehicle_id", "set null"],
  ["chat_threads", "1 : N", "chat_messages", "thread_id", "cascade"],
  ["dealers", "1 : N", "admin_users", "dealer_id", "set null"],
  ["admin_users", "1 : N", "admin_user_roles", "admin_user_id", "cascade"],
  ["admin_roles", "1 : N", "admin_user_roles", "role_id", "cascade"],
  ["admin_users", "1 : N", "trim_node_state", "verified_by", "set null"],
  ["admin_users", "1 : N", "fitment_links", "created_by", "restrict"],
  ["admin_users", "1 : N", "audit_log", "actor_id", "restrict"],
  ["admin_users", "1 : N", "settings", "updated_by", "restrict"]
];

export const ENUMS = [
  { name: "order_status", vals: [["processing", "info"], ["shipped", "info"], ["delivered", "good"], ["refunded", "bad"], ["cancelled", "bad"]] },
  { name: "listing_status", vals: [["pending", "warn"], ["live", "good"], ["rejected", "bad"], ["paused", "mute"]] },
  { name: "dealer_status", vals: [["pending", "warn"], ["active", "good"], ["suspended", "bad"]] },
  { name: "fit_confidence", vals: [["confirmed", "good"], ["probable", "warn"], ["unverified", "bad"]] },
  { name: "fit_state", vals: [["fits", "good"], ["unknown", "warn"], ["does_not_fit", "bad"]] },
  { name: "payment_status", vals: [["pending", "warn"], ["paid", "good"], ["failed", "bad"]] },
  { name: "shipment_status", vals: [["packing", "mute"], ["in_transit", "info"], ["out_for_delivery", "info"], ["delivered", "good"], ["returned", "bad"]] },
  { name: "node_key", vals: [["engine", "mute"], ["front_brakes", "mute"], ["rear_brakes", "mute"], ["suspension", "mute"], ["transmission", "mute"], ["electrical", "mute"], ["exhaust", "mute"]] },
  { name: "admin_role", vals: [["super_admin", "info"], ["ops", "info"], ["catalog", "info"], ["read_only", "mute"]] },
  { name: "locale_code", vals: [["ru", "mute"], ["en", "mute"], ["uz", "mute"]] }
];
