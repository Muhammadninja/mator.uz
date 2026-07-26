# Mator Grafana Dashboards (Phase B)

Five importable Grafana dashboards for the Prometheus metrics the backend exposes
at `/metrics` (Phase A). **Visualization only** — no backend code, metric, queue
or schema is touched by anything in this directory.

| Dashboard | File | UID | Refresh | Default range | Panels |
|---|---|---|---|---|---|
| Backend Overview | `dashboards/backend-overview.json` | `mator-backend-overview` | 30s | `now-6h` | 24 |
| BullMQ Queues | `dashboards/bullmq.json` | `mator-bullmq` | 30s | `now-6h` | 17 |
| Image Processing | `dashboards/image-processing.json` | `mator-image-processing` | 30s | `now-12h` | 13 |
| SMS Delivery | `dashboards/sms.json` | `mator-sms` | 30s | `now-12h` | 16 |
| Business Metrics | `dashboards/business.json` | `mator-business` | 5m | `now-7d` | 12 |

All five are tagged `mator` and cross-link to each other via the **Mator
Dashboards** dropdown in the top-right, preserving the time range and variables.

---

## Import

### Option A — UI import (quickest)

1. Grafana → **Dashboards → New → Import**.
2. **Upload JSON file**, pick a file from `dashboards/`.
3. Select your Prometheus datasource when prompted.
4. **Import**.

Repeat per file. Nothing needs editing first: every panel references a
`${datasource}` variable rather than a hard-coded datasource UID, which is what
makes these files portable across Grafana instances.

### Option B — Provisioning (recommended for servers)

Mount this directory and let Grafana load everything on startup:

```yaml
# docker-compose.yml
services:
  grafana:
    image: grafana/grafana:11.5.2
    ports: ['3001:3000']
    volumes:
      - ./Backend/grafana/provisioning/datasources:/etc/grafana/provisioning/datasources:ro
      - ./Backend/grafana/provisioning/dashboards:/etc/grafana/provisioning/dashboards:ro
      - ./Backend/grafana/dashboards:/etc/grafana/provisioning/dashboards/mator:ro
```

Edit `provisioning/datasources/prometheus.yml` so `url:` points at your
Prometheus. Dashboards land in a **Mator** folder.

> With provisioning, `${datasource}` resolves to the provisioned datasource
> (uid `prometheus`) automatically.

### Prometheus scrape config

```yaml
scrape_configs:
  - job_name: mator-backend
    scrape_interval: 15s
    scrape_timeout: 10s
    static_configs:
      - targets: ['10.0.0.5:3000']
```

Set `timeInterval: 15s` on the Grafana datasource to match. Grafana derives
`$__rate_interval` from it; a mismatch makes every `rate()` panel either noisy or
empty.

---

## Variables

| Variable | Dashboards | Source |
|---|---|---|
| `datasource` | all | Prometheus datasource picker |
| `instance` | all | `label_values(…, instance)` |
| `queue` | BullMQ | `label_values(mator_bullmq_jobs, queue)` |
| `provider` | SMS | `label_values(mator_sms_sent_total, provider)` |
| `template` | SMS | `label_values(mator_sms_sent_total, template)` |
| `method`, `route` | Backend Overview | `label_values(mator_http_requests_total, …)` |

All are multi-select with an **All** option (`.*`) and `refresh: 2` (re-resolve
on time-range change). **Queues are discovered from the metrics**, so a newly
registered queue appears with no dashboard edit.

---

## PromQL reference

`$__rate_interval` is used everywhere instead of a hard-coded `[5m]`: it
guarantees ≥4 scrapes per window at any zoom level, so graphs neither empty out
when zoomed in nor lie when zoomed out. Every ratio wraps its denominator in
`clamp_min(…, 1e-9)` and its numerator in `or vector(0)` so quiet periods render
`0` instead of `NaN`/"No data".

### Backend Overview

| Panel | PromQL |
|---|---|
| Requests/sec | `sum(rate(mator_http_requests_total{instance=~"$instance"}[$__rate_interval]))` |
| Total Requests | `sum(increase(mator_http_requests_total{…}[$__range]))` |
| Error Rate | `100 * (sum(rate(mator_http_requests_total{…,status_code=~"4..\|5.."}[…])) or vector(0)) / clamp_min(sum(rate(mator_http_requests_total{…}[…])), 1e-9)` |
| P50 / P95 / P99 | `histogram_quantile(0.95, sum by (le) (rate(mator_http_request_duration_seconds_bucket{…}[…])))` |
| Average latency | `sum(rate(…_duration_seconds_sum{…}[…])) / clamp_min(sum(rate(…_duration_seconds_count{…}[…])), 1e-9)` |
| In-flight | `sum(mator_http_requests_in_flight{…})` |
| By method / status / route | `sum by (method\|status_code\|route) (rate(mator_http_requests_total{…}[…]))` |
| Slowest routes | `topk(10, histogram_quantile(0.95, sum by (le, route) (rate(…_bucket{…}[…]))))` |
| CPU | `100 * sum by (instance) (rate(mator_process_cpu_seconds_total{…}[…]))` |
| Memory | `sum by (instance) (mator_process_resident_memory_bytes{…})` |
| Heap | `sum by (instance) (mator_nodejs_heap_size_used_bytes{…})` / `…_total_bytes` |
| Event loop lag | `max by (instance) (mator_nodejs_eventloop_lag_p99_seconds{…})` |
| GC | `sum by (kind) (rate(mator_nodejs_gc_duration_seconds_sum{…}[…]))` |
| Uptime | `min(time() - mator_process_start_time_seconds{…})` |

### BullMQ

| Panel | PromQL |
|---|---|
| Waiting / Active / Delayed / Failed / Completed | `max by (queue) (mator_bullmq_jobs{…, state="waiting"})` |
| Workers | `max by (queue) (mator_bullmq_workers{…})` |
| Jobs/sec | `sum by (queue) (rate(mator_bullmq_jobs_processed_total{…}[…]))` |
| Success vs failure | `sum by (result) (rate(mator_bullmq_jobs_processed_total{…}[…]))` |
| Failure rate % | `100 * (sum by (queue) (rate(…{result="failure"}[…])) or vector(0)) / clamp_min(sum by (queue) (rate(…[…])), 1e-9)` |
| Duration P95 | `histogram_quantile(0.95, sum by (le, queue) (rate(mator_bullmq_job_duration_seconds_bucket{…}[…])))` |
| Avg duration | `sum by (queue) (rate(…_sum{…}[…])) / clamp_min(sum by (queue) (rate(…_count{…}[…])), 1e-9)` |

### Image Processing

| Panel | PromQL |
|---|---|
| Success / failure rate | `100 * (sum(increase(mator_image_processing_total{result="success"}[$__range])) or vector(0)) / clamp_min(sum(increase(mator_image_processing_total{…}[$__range])), 1e-9)` |
| Successful / failed jobs | `sum(increase(mator_image_processing_total{…, result="success"\|"failure"}[$__range]))` |
| Avg duration | `sum(rate(mator_image_processing_duration_seconds_sum{…}[…])) / clamp_min(sum(rate(…_count{…}[…])), 1e-9)` |
| P50/P95/P99 | `histogram_quantile(0.95, sum by (le) (rate(mator_image_processing_duration_seconds_bucket{…}[…])))` |
| Throughput | `60 * sum by (result) (rate(mator_image_processing_total{…}[…]))` |
| Bucket distribution | `sum by (le) (rate(…_bucket{…}[…])) / clamp_min(scalar(sum(rate(…_count{…}[…]))), 1e-9)` |

### SMS

| Panel | PromQL |
|---|---|
| Sent/min | `60 * (sum(rate(mator_sms_sent_total{…}[…])) or vector(0))` |
| Failed/min | `60 * (sum(rate(mator_sms_failed_total{…}[…])) or vector(0))` |
| Success rate | `100 * sent / clamp_min(sent + failed, 1e-9)` (both `increase(…[$__range])`) |
| By provider | `60 * sum by (provider) (rate(mator_sms_sent_total{…}[…]))` |
| Failure % by provider | `100 * failed_by_provider / clamp_min(sent_by_provider + failed_by_provider, 1e-9)` |
| By template | `60 * sum by (template) (rate(mator_sms_sent_total{…}[…]))` |
| Failure reasons | `60 * sum by (reason) (rate(mator_sms_failed_total{…}[…]))` |
| Total SMS Cost | `max(mator_sms_cost_uzs{…})` |
| SMS Cost by Provider | `max by (provider) (mator_sms_provider_cost_uzs{…})` |

### Business

| Panel | PromQL |
|---|---|
| Drafts created | `sum(increase(mator_drafts_created_total{…}[$__range]))` |
| Products published | `sum(increase(mator_products_published_total{…}[$__range]))` |
| Drafts expired | `sum(increase(mator_drafts_expired_total{…}[$__range]))` |
| Publication success rate | `100 * published / clamp_min(published + expired, 1e-9)` |
| Publications/hour | `3600 * (sum(rate(mator_products_published_total{…}[…])) or vector(0))` |
| SMS sent / failed | `sum(increase(mator_sms_{sent,failed}_total{…}[$__range]))` |

---

## Regenerating

The JSON is generated from typed builders in `scripts/grafana/` so PromQL and
panel options stay reviewable and consistent:

```bash
npm run grafana:build   # regenerate dashboards/*.json
npm run grafana:test    # 158 validation checks
npm run grafana:check   # both
```

Edit the builders, not the JSON — a hand-edit is overwritten on the next build.

### What the tests verify

- Every metric referenced **exists** in the backend's real prom-client registry.
- Every label used **is declared** on that metric (`le` on `_bucket`, etc).
- Every expression **parses** with Prometheus's own PromQL grammar
  (`@prometheus-io/lezer-promql`), with a negative control proving the check can fail.
- No panel overlaps another on the 24-column grid; panel ids are unique.
- Counters are always wrapped in `rate()`/`increase()` — never graphed raw.
- Every division guards its denominator with `clamp_min`.
- Every panel has a datasource and a non-empty query; only declared variables are used.
- BullMQ gauges use `max`, never `sum`, across instances.

---

## Operational notes

**BullMQ gauges use `max by (queue)`, not `sum`.** Under PM2 cluster mode every
backend instance scrapes the *same* Redis and reports identical queue depths.
`sum()` would multiply the backlog by the instance count and invent a problem
that does not exist. Counters (`*_total`) are per-process and *are* summed —
that is correct for them.

**`bullmq_jobs{state="completed"|"failed"}` are retained-set sizes**, bounded by
`removeOnComplete`/`removeOnFail`, so they plateau by design. For true throughput
use `bullmq_jobs_processed_total`.

**Job duration excludes queue waiting time.** It is measured `processedOn →
finishedOn`, i.e. worker time only. A backlog shows up as rising *waiting*, not
rising duration.

**Image latency: use the Image Processing dashboard.** The generic
`bullmq_job_duration_seconds` histogram tops out at 120s (tuned for short SMS/push
jobs); `image_processing_duration_seconds` extends to 300s, so it is the
authoritative view for that pipeline.

**Failures are counted per job, not per attempt** — only after retries are
exhausted. One flaky job with 3 attempts is one failure.

**`sms_sent_total` means "the provider accepted it"**, not "delivered to a
handset". Final delivery status arrives via provider callbacks and is not in
these metrics.

**SMS cost gauges use `max`, never `sum`, and are never wrapped in `rate()`.**
`sms_cost_uzs` and `sms_provider_cost_uzs` are cumulative sums of
`sms_messages.price_uzs` read from Postgres at scrape time, so every instance
reports the same DB-wide figure — `sum()` would multiply spend by the instance
count. Being DB-backed they survive deploys, so they are **gauges, not counters**,
and carry no `_total` suffix: that suffix is a Prometheus convention for counters
and would wrongly invite `rate()`/`increase()`, which is meaningless on a value
that never resets. They show **spend to date**, not spend within the dashboard
time range, and cover only sends where an operator price was resolved (a NULL
`price_uzs` contributes 0). Set `METRICS_SMS_COST_ENABLED=false` to take the
aggregate query off the scrape path.

**Publication success rate is `published / (published + expired)`** — the share
of *settled* drafts. Dividing by `created` would count drafts that simply have
not finished yet and would report a misleadingly low number that improves on its
own. In-progress volume is shown separately as "Drafts In Flight" (which can read
negative if drafts from before the window settle inside it).

### Recommended time ranges

| Use case | Range | Refresh |
|---|---|---|
| Live incident | `now-1h` / `now-3h` | 30s |
| Daily ops review | `now-24h` | 1m |
| Capacity / trends | `now-7d` | 5m |
| Business reporting | `now-30d` | off |

Refresh should never be faster than the 15s scrape — a faster refresh re-renders
identical points while multiplying query load.

---

## Version tested

- **Dashboard schema:** `schemaVersion: 39` (Grafana 10.x / 11.x native)
- **Built and validated against:** Grafana 11.x JSON model; panel types
  `timeseries`, `stat`, `gauge`, `table`, `row` — all stable since Grafana 9.
- **Prometheus:** PromQL validated with the `@prometheus-io/lezer-promql` 0.313.1
  grammar (Prometheus 3.x).

> **Not rendered live.** The environment used to build these had no Docker,
> Prometheus or Grafana available, so the dashboards were verified structurally
> and syntactically (158 automated checks) rather than by loading them in a
> running Grafana. No screenshots are included for that reason — I have not
> visually confirmed the rendered layout. The grid-overlap and schema tests exist
> specifically to cover what a visual check would otherwise catch, but a quick
> look after your first import is still worth the minute it takes.
