# Handoff: Mator Admin — 3D Database Blueprint

An interactive 3D map of the whole Postgres schema, built so that **relationships
read first**. Every table is a panel, every foreign key is an arc; hovering or
selecting a table isolates its keys, labels them with the actual FK column, and
shows the full column list beside the graph.

Ships as an admin route (`/platform/blueprint`, super-admin + catalog roles) next
to the flat 2D blueprint page, which stays the printable reference.

**Fidelity: high.** Layout, motion, colors, camera behaviour and interaction are
final. The schema payload is our model of the platform — swap it for generated
metadata (see *Wiring to real metadata*); nothing else changes.

## Package
```
prototype/
  Mator DB Blueprint 3D.dc.html   the 3D page (open in a browser)
  dbgraph3d.js                    the three.js scene: towers, panels, arcs, camera
  db-schema.js                    schema payload shared by the scene AND the panels
  Mator DB Blueprint.dc.html      the flat 2D page, same data, for print/reference
  support.js                      runtime for the reference only — do not ship
```
Try: hover any panel, click it, click a relationship row to hop along the graph,
switch to **Cross-domain**, press `F` / `R` / `Esc`.

Stack: React 18 + **three.js 0.166** (`OrbitControls` only, no post-processing).
Port to `@react-three/fiber` + `drei` if you prefer — the scene has no custom
shaders and the whole contract is 4 attributes and 2 events.

---

## Layout
Full-bleed `<canvas>` (`position:absolute; inset:0`) with a radial vignette
(`radial-gradient(120% 90% at 50% 45%, transparent 52%, rgba(0,0,0,.78))`) and
floating glass panels above it. Root `min-width:1200px`, `min-height:720px`.

| Region | Geometry |
|---|---|
| Header | `top/left/right:14`, three glass groups: brand lockup · meta strip (Engine · Tables · Foreign keys · Cross-domain) · search + `GRAPH LIVE` FPS chip |
| Left column | `left:14 top:92 bottom:16`, width **250**: Domain towers · Connections (mode buttons + legend) · Most connected (scrolls) |
| Bottom bar | `left:278 bottom:16`: Reset view · Clear selection · shortcut hint · `tracing <table>` chip while hovering |
| Right column | `right:14 top:92 bottom:16`, width **392**: selected-table card, or the "how to read this" card when nothing is selected |

Glass recipe: `background:rgba(11,11,11,.86–.9); backdrop-filter:blur(16px);
border:1px solid #2a2a2a; border-radius:14px; box-shadow:0 24px 48px rgba(0,0,0,.5)`.

## Tokens
Canvas `#050505` · panel `rgba(11,11,11,.88)` · raised `#141414` · border `#2a2a2a`
· divider `#1f1f1f` · text `#ffffff` · muted `#8f8f8f` · faint `#6a6a6a`.

Domains — Identity & Garage `#3b82f6` · Catalog & Inventory `#8b5cf6` ·
Vehicle & Fitment `#06b6d4` · Commerce `#22c55e` · Engagement `#f59e0b` ·
Platform & Audit `#ef4444`.
Keys — PK `#f59e0b` · FK `#3b82f6` · UQ `#8b5cf6` · IDX `#22c55e`.
On delete — cascade `#ef4444` · restrict `#3b82f6` · set null `#f59e0b`.
Tinted chips are always `color` + `background: color+1f` (+ `33` border).

Type: Figtree for prose; **JetBrains Mono for every identifier**, in the panels
*and* on the 3D sprites. Section labels 8.5/800 uppercase `.2em` faint.

---

## The scene (`dbgraph3d.js`)
`<dbgraph-stage>` custom element.
**Attributes:** `selected` (table name — highlights + flies to),
`domain-filter` (`all` | domain id), `query` (name substring), `edges-mode`
(`all` | `cross` | `selected`).
**Events (bubbling, composed):** `table-select {name}` (click; `null` clears),
`table-hover {name}`, `graph-stats {fps}` once per second.
**Methods:** `focus(name)`, `resetView()`.

### Layout of the graph
- **6 towers** on a ring, radius `TOWER_R = 8.4`, one per domain at
  `angle = i/6 · 2π`. Each tower has a floor disc (r 1.5, 7% domain color), a
  ring (1.42→1.52, 55%), a thin vertical beam, and a domain name sprite at the base.
- **Panels**: `THREE.Sprite`, scale `2.62 × 0.6`, stacked from `y = 1.1` with
  `STEP = 0.86`, **sorted by connection count descending** so hubs sit low and
  legible. Sprites billboard, so text is never skewed.
- **Panel texture** is a 2×-resolution canvas (1024×232, anisotropy 8): domain
  color bar, mono table name, and two right-aligned counts — `N col` / `N fk`.
  Three variants are pre-rendered per table: `idle` (dark), `near` (lighter
  frame — a connected neighbour), `active` (inverted white card).
- **Arcs**: one `TubeGeometry` (r 0.02, 34 segments) per FK along a
  `QuadraticBezierCurve3`. The control point is pushed radially **outward** from
  the graph center — `2.5` for same-tower keys (so they loop clear of the stack)
  and `1.1 + distance·0.12` for cross-tower keys, plus `+1.5` in Y. A cone
  arrowhead sits at `t = 0.93` pointing at the child.

### Reading states
| State | Panels | Arcs |
|---|---|---|
| Idle | all 100% | 13% in the parent domain color |
| Focus (hover or selected) | active 100% @1.3×, neighbours 100% @1.1×, everything else 15% | **outgoing 98% white**, **incoming 72% domain tint**, unrelated 3.5% |
| Domain filter / search miss | 10% | 1.2% |
| `edges-mode: cross` | — | same-tower keys drop to 2% |
| `edges-mode: selected` | — | only the focused table's keys draw |

Outgoing vs incoming is the core affordance: **white means this table is the
parent**. A white dot travels each active arc parent → child on a 1.4s loop.

**FK labels** are DOM chips in an overlay div (one per edge, created up front,
opacity-toggled). While an edge is active its curve midpoint is projected each
frame and the chip prints `"<fk column>  <cardinality>"`; it hides when the point
goes behind the camera. This is what makes the graph self-explaining — keep it.

### Camera
`PerspectiveCamera(42)`, home `(0.5, 10.5, 24)` looking at `(0, 4.2, 0)`.
`OrbitControls` damping .07, distance 5–46, `maxPolarAngle π·0.52`, autorotate
.32 which switches off on interaction and back on after **4 s** idle.
`focus(name)` lerps camera to `node + radial·6.2 + (0, 2.6, 0)` and target to the
node (`lerp(goal, 1 − 0.002^dt)` per frame). Fog `FogExp2(0x050505, 0.022)`.
Renderer uses `preserveDrawingBuffer: true` so the canvas can be exported.

### Picking
Raycast against the sprites on `pointerup`, only when the pointer moved **< 5 px**
(orbiting never selects), and only sprites above 30% opacity — dimmed tables are
unclickable by design. Hover sets `cursor:pointer` and emits `table-hover`.

---

## Panels
**Left — Domain towers**: `All domains` + 6 rows (color chip, label, count);
sets `domain-filter`. **Connections**: All keys / Cross-domain / Selected only
(active = white fill, `#050505` text) + the 4-line legend explaining arc colors.
**Most connected**: top 10 tables by degree, click to select + fly.

**Right — selected table**: header (3px left border in the domain color, mono
name, domain pill, column count) · description · **Columns** rows
(`34px | 1.15fr | .9fr | 1.3fr` grid: key badge · name · type · note, PK rows get
a `#f59e0b0a` wash) · **Relationships (n)** rows — direction chip (`1 : N →` /
`← N : 1`), the other table, FK column, on-delete pill; clicking a row selects
that table, so you can walk the graph without touching the canvas.

**Right — nothing selected**: the "how to read this" card — counts, what towers
and arcs mean, and per-domain cross-domain coupling bars.

**Keyboard**: `F` fly to selection · `R` reset view · `Esc` clear.
Ignored while an input is focused.

---

## Wiring to real metadata
```
GET /admin/schema → { domains[], tables[], relations[], generatedAt, migrationVersion }
```
Generate `tables` / `relations` from `information_schema` + `pg_catalog` (or from
your Prisma/Drizzle schema at build time) and keep the hand-written `desc`
strings and the `domain` assignment in a small `table-notes.ts` keyed by table
name, merged server-side. Show `migrationVersion` and `generatedAt` in the header
meta strip. The payload shape is exactly `db-schema.js`:

```ts
DOMAINS:   { id, label, color, note }[]
TABLES:    { d: domainId, name, desc, cols: [key, name, type, note][] }[]   // key ∈ '' | PK | FK | UQ | IDX
RELATIONS: [parent, cardinality, child, fkColumnOrJoinTable, onDelete][]
```
Layout is derived, not authored: tower = `d`, height order = degree, arc = a
`RELATIONS` row. Adding a table changes nothing but the data file.

## Performance
~215 scene objects, ~180 draw calls, ~23k triangles at 60 FPS. Sprites and tubes
are built once; state changes only touch `material.opacity` / `.color` / `.map`,
never geometry. Two guards to keep if you extend it: pre-render the three panel
textures per table (don't redraw canvases on hover), and animate only the active
edges' dots. Above ~120 tables, cluster tables per tower into stacked groups that
expand on select rather than growing towers vertically.

## Accessibility & fallbacks
Every 3D action has a DOM equivalent (tower list, hub list, relationship rows) —
keep those focusable with a visible `#ffffff` focus ring and `aria-pressed`.
Ship the flat 2D blueprint page as the no-WebGL fallback and the print view;
detect context loss and link to it. Add a reduced-motion setting that disables
autorotate, the travelling dots, and camera easing.

## Open questions
Should dealer-scoped staff see the whole schema or only their tables · whether to
overlay live row counts / table sizes on the panels · whether `edges-mode` should
gain a "path between two tables" mode (pick A and B, highlight the join path) ·
export of the current view as PNG for docs.
