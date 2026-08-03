#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# AI Sourcing — pre-release smoke harness (REST + admin lifecycle + optional WS).
#
# Asserts the DETERMINISTIC invariants of POST /api/ai-chat/message and the
# admin ticket API. LLM output is non-deterministic, so we assert INVARIANTS
# (phantom-ticket prevention, branch = FOUND|CREATE never GENERAL for a clear
# part request, canonical SLA text, HTTP contract) rather than exact extraction.
#
# Usage:
#   API_BASE=http://localhost:3000 \
#   ADMIN_EMAIL=admin@mator.uz ADMIN_PASSWORD=... \
#   [RUN_WS=1] bash scripts/qa/ai-sourcing-smoke.sh
#
# Exit code 0 = all passed (CI-friendly), 1 = one or more failures, 2 = setup error.
# Deps: curl, jq (required); node + ws (optional, for RUN_WS=1).
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

API_BASE="${API_BASE:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
RUN_WS="${RUN_WS:-0}"
THROTTLE_SLEEP="${THROTTLE_SLEEP:-1}"   # spacing between chat calls (endpoint is 15/min)
CURL_TIMEOUT="${CURL_TIMEOUT:-40}"      # Claude call can take a few seconds

CANON_SLA="Спасибо за обращение! Этой позиции сейчас нет в нашем каталоге. Наш отдел закупок уже проверяет цены и свяжется с вами в течение 15 минут."
CANON_FOUND="Нашёл подходящие товары в наличии — можете выбрать из списка ниже."

# ── output helpers ───────────────────────────────────────────────────────────
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  G=$'\e[32m'; R=$'\e[31m'; Y=$'\e[33m'; DIM=$'\e[2m'; B=$'\e[1m'; N=$'\e[0m'
else G=""; R=""; Y=""; DIM=""; B=""; N=""; fi

PASS=0; FAIL=0; SKIP=0
pass(){ PASS=$((PASS+1)); printf '  %sPASS%s %s\n' "$G" "$N" "$1"; }
fail(){ FAIL=$((FAIL+1)); printf '  %sFAIL%s %s\n' "$R" "$N" "$1"; [ -n "${2:-}" ] && printf '       %s%s%s\n' "$DIM" "$2" "$N"; }
skip(){ SKIP=$((SKIP+1)); printf '  %sSKIP%s %s\n' "$Y" "$N" "$1"; }
group(){ printf '\n%s%s%s\n' "$B" "$1" "$N"; }

assert_eq(){ [ "$2" = "$3" ] && pass "$1" || fail "$1" "expected [$3], got [$2]"; }
assert_ne(){ [ "$2" != "$3" ] && pass "$1" || fail "$1" "did not expect [$3]"; }
assert_contains(){ case "$2" in *"$3"*) pass "$1";; *) fail "$1" "[$2] does not contain [$3]";; esac; }

# ── http: prints "<http_code>\t<body>" ───────────────────────────────────────
http(){ # method path token? json?
  local method="$1" path="$2" token="${3:-}" data="${4:-}" args=()
  args=(-sS -m "$CURL_TIMEOUT" -o - -w $'\n%{http_code}' -X "$method" "$API_BASE$path")
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  if [ -n "$data" ]; then args+=(-H 'Content-Type: application/json' --data "$data"); fi
  local raw code body
  raw="$(curl "${args[@]}" 2>/dev/null)"; code="${raw##*$'\n'}"; body="${raw%$'\n'*}"
  printf '%s\t%s' "$code" "$body"
}
chat(){ # message → "<code>\t<body>"; spaces calls to respect the throttle
  sleep "$THROTTLE_SLEEP"
  http POST /api/ai-chat/message "" "$(jq -nc --arg m "$1" '{message:$m}')"
}
field(){ printf '%s' "$1" | jq -r "$2 // empty" 2>/dev/null; }

# ── preflight ────────────────────────────────────────────────────────────────
command -v curl >/dev/null || { echo "curl required"; exit 2; }
command -v jq   >/dev/null || { echo "jq required";   exit 2; }
[ -n "$ADMIN_EMAIL" ] && [ -n "$ADMIN_PASSWORD" ] || { echo "set ADMIN_EMAIL and ADMIN_PASSWORD"; exit 2; }

printf '%sAI Sourcing smoke%s  →  %s\n' "$B" "$N" "$API_BASE"

group "§S  Admin login"
LOGIN="$(http POST /v1/auth/admin/login "" "$(jq -nc --arg e "$ADMIN_EMAIL" --arg p "$ADMIN_PASSWORD" '{email:$e,password:$p}')")"
TOKEN="$(field "${LOGIN#*$'\t'}" '.accessToken')"
[ -n "$TOKEN" ] || { echo "  login failed: ${LOGIN}"; exit 2; }
pass "admin token acquired (${TOKEN:0:12}…)"

ticket_total(){ field "$(http GET '/v1/admin/sourcing-tickets?limit=1' "$TOKEN")" '.meta.total'; }
BASE_TOTAL="$(ticket_total)"; [ -n "$BASE_TOTAL" ] || { echo "  cannot read ticket total"; exit 2; }
printf '  %sbaseline sourcing_tickets.total = %s%s\n' "$DIM" "$BASE_TOTAL" "$N"

# ── §1 HTTP contract ─────────────────────────────────────────────────────────
group "§1  Endpoint contract"
R1="$(chat 'Здравствуйте')"; C1="${R1%%$'\t'*}"; B1="${R1#*$'\t'}"
assert_eq "200 on a valid message" "$C1" "200"
assert_contains "response is the ChatResponse shape" "$(field "$B1" '{r:.reply_text,i:.intent,e:.extracted_data}|tostring')" '"i":'

# ── §3 phantom-ticket prevention (deterministic, highest value) ──────────────
group "§3  Phantom-ticket prevention (no part_name ⇒ no ticket)"
for msg in "у вас есть запчасти на авто?" "Какая сегодня погода в Ташкенте?" "123456"; do
  before="$(ticket_total)"
  R="$(chat "$msg")"; body="${R#*$'\t'}"; intent="$(field "$body" '.intent')"
  after="$(ticket_total)"
  assert_ne "‹$msg› not a ticket"  "$intent" "CREATE_SOURCING_TICKET"
  assert_eq "‹$msg› total unchanged" "$after" "$before"
done

# ── §2 ticket creation + canonical SLA (forced-miss via a nonce part) ────────
group "§2  CREATE_SOURCING_TICKET + canonical SLA"
NONCE="QASMOKE$(date +%s)$$"
CREATED_ID=""
before="$(ticket_total)"
# A concrete part request whose part cannot exist in the catalog (pure nonce, so
# no token can match title/brand under the ranked search) → forces CREATE.
R2="$(chat "Нужна деталь с артикулом $NONCE на Chevrolet Malibu 2019, срочно")"
c2="${R2%%$'\t'*}"; b2="${R2#*$'\t'}"; intent2="$(field "$b2" '.intent')"; reply2="$(field "$b2" '.reply_text')"
assert_eq "200" "$c2" "200"
if [ "$intent2" = "CREATE_SOURCING_TICKET" ]; then
  pass "clear part request ⇒ CREATE_SOURCING_TICKET"
  assert_eq "reply_text is the canonical SLA copy" "$reply2" "$CANON_SLA"
  assert_eq "total incremented by 1" "$(ticket_total)" "$((before+1))"
  # find our ticket by the nonce in raw_message (newest first)
  LIST="$(http GET '/v1/admin/sourcing-tickets?limit=5' "$TOKEN")"
  CREATED_ID="$(field "${LIST#*$'\t'}" ".data[] | select(.rawMessage | contains(\"$NONCE\")) | .id" | head -n1)"
  [ -n "$CREATED_ID" ] && pass "ticket visible in admin list (id ${CREATED_ID:0:8}…)" \
                        || fail "ticket not found in admin list by nonce"
else
  fail "clear part request should not be GENERAL_QUESTION" "got intent=$intent2 (LLM misclassified, or catalog matched → FOUND)"
fi

# cleanup: always close the ticket we created (no DELETE endpoint exists)
cleanup(){ [ -n "$CREATED_ID" ] && http PATCH "/v1/admin/sourcing-tickets/$CREATED_ID/status" "$TOKEN" '{"status":"CLOSED"}' >/dev/null 2>&1; }
trap cleanup EXIT

# ── §6 admin REST lifecycle + validation ─────────────────────────────────────
group "§6  Admin REST — lifecycle & validation"
LIST="$(http GET '/v1/admin/sourcing-tickets?status=PENDING&page=1&limit=20' "$TOKEN")"
assert_eq "GET list → 200" "${LIST%%$'\t'*}" "200"
assert_contains "list envelope { success, data, meta }" "$(field "${LIST#*$'\t'}" '{s:.success,m:.meta}|tostring')" '"total":'

NOAUTH="$(http GET '/v1/admin/sourcing-tickets' "")"
assert_eq "GET list without token → 401" "${NOAUTH%%$'\t'*}" "401"

if [ -n "$CREATED_ID" ]; then
  P1="$(http PATCH "/v1/admin/sourcing-tickets/$CREATED_ID/status" "$TOKEN" '{"status":"IN_PROGRESS"}')"
  assert_eq "PATCH PENDING→IN_PROGRESS → 200" "${P1%%$'\t'*}" "200"
  assert_eq "  data.status = IN_PROGRESS" "$(field "${P1#*$'\t'}" '.data.status')" "IN_PROGRESS"
  P2="$(http PATCH "/v1/admin/sourcing-tickets/$CREATED_ID/status" "$TOKEN" '{"status":"CLOSED"}')"
  assert_eq "PATCH IN_PROGRESS→CLOSED → 200" "${P2%%$'\t'*}" "200"
  BAD="$(http PATCH "/v1/admin/sourcing-tickets/$CREATED_ID/status" "$TOKEN" '{"status":"DONE"}')"
  assert_eq "PATCH invalid enum → 400" "${BAD%%$'\t'*}" "400"
else
  skip "PATCH lifecycle (no ticket was created in §2)"
fi

UUID="$(http PATCH '/v1/admin/sourcing-tickets/not-a-uuid/status' "$TOKEN" '{"status":"CLOSED"}')"
assert_eq "PATCH malformed uuid → 400" "${UUID%%$'\t'*}" "400"
MISS="$(http PATCH '/v1/admin/sourcing-tickets/00000000-0000-0000-0000-000000000000/status' "$TOKEN" '{"status":"CLOSED"}')"
assert_eq "PATCH valid-but-missing uuid → 404" "${MISS%%$'\t'*}" "404"

# ── §7 multi-turn context (history) — the "re-asks the car" regression ───────
group "§7  Multi-turn context (history replay)"
R7A="$(chat 'У меня Chevrolet Gentra')"
REPLY7A="$(field "${R7A#*$'\t'}" '.reply_text')"
HIST="$(jq -nc --arg u 'У меня Chevrolet Gentra' --arg a "$REPLY7A" \
  '[{role:"user",content:$u},{role:"assistant",content:$a}]')"
sleep "$THROTTLE_SLEEP"
# Turn 2 names only the part; the car must be remembered from history.
R7B="$(http POST /api/ai-chat/message '' \
  "$(jq -nc --arg m 'Нужен масляный фильтр' --argjson h "$HIST" '{message:$m,history:$h}')")"
b7="${R7B#*$'\t'}"; MODEL7="$(field "$b7" '.extracted_data.model')"; BRAND7="$(field "$b7" '.extracted_data.brand')"
if printf '%s %s' "$MODEL7" "$BRAND7" | grep -qiE 'gentra|chevrolet'; then
  pass "vehicle carried across turns via history (part-only turn 2 still knows the car)"
else
  fail "vehicle NOT carried — endpoint acting stateless?" "turn-2 model='$MODEL7' brand='$BRAND7'"
fi

close_ticket_by_nonce(){ # $1 = nonce
  local id
  id="$(field "$(http GET '/v1/admin/sourcing-tickets?limit=8' "$TOKEN")" \
    ".data[] | select(.rawMessage | contains(\"$1\")) | .id" | head -n1)"
  [ -n "$id" ] && http PATCH "/v1/admin/sourcing-tickets/$id/status" "$TOKEN" '{"status":"CLOSED"}' >/dev/null 2>&1
}

# ── §8 de-duplication (same part within 10 min → one ticket) ─────────────────
group "§8  De-duplication"
DNONCE="QADEDUP$(date +%s)$$"
before8="$(ticket_total)"
chat "Нужна деталь с артикулом $DNONCE, срочно" >/dev/null
chat "Нужна деталь с артикулом $DNONCE, срочно" >/dev/null   # identical → must NOT open a 2nd
assert_eq "same part twice ⇒ exactly ONE ticket" "$(ticket_total)" "$((before8 + 1))"
close_ticket_by_nonce "$DNONCE"

# ── §9 localized canonical reply (Uzbek-Latin) ───────────────────────────────
group "§9  Localized reply (uz_lat)"
UNONCE="QAUZ$(date +%s)$$"
# Concrete part (amortizator) in Uzbek-Latin (markers: menga/kerak) → a canonical
# uz_lat reply (FOUND or CREATE — both contain "mahsulot").
R9="$(chat "Menga $UNONCE amortizator kerak")"
REPLY9="$(field "${R9#*$'\t'}" '.reply_text')"
case "$REPLY9" in
  *mahsulot*) pass "reply localized to Uzbek-Latin (canonical)" ;;
  *)          fail "reply not localized (expected uz_lat)" "got: $REPLY9" ;;
esac
close_ticket_by_nonce "$UNONCE"

# ── §5 admin WebSocket (optional) ────────────────────────────────────────────
if [ "$RUN_WS" = "1" ]; then
  group "§5  Admin WebSocket /admin-events"
  if command -v node >/dev/null && node -e "require('ws')" >/dev/null 2>&1; then
    WS_BASE="$(printf '%s' "$API_BASE" | sed -E 's#^http#ws#')"
    if node -e '
      const WebSocket = require("ws");
      const base = process.argv[1], token = process.argv[2];
      const withTimeout = (p, ms, label) =>
        Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error("timeout:" + label)), ms))]);
      // Unauthorized: gateway may reject at handshake (error) or accept-then-close(4401).
      const rejected = (url) => new Promise((res) => {
        const w = new WebSocket(url);
        w.on("close", (c) => res("close:" + c));
        w.on("error", () => res("error"));
      });
      // Authorized: open → send ping → expect pong.
      const pinged = (url) => new Promise((res, rej) => {
        const w = new WebSocket(url); let ok = false;
        w.on("open", () => w.send(JSON.stringify({ type: "ping" })));
        w.on("message", (d) => { try { if (JSON.parse(d.toString()).type === "pong") { ok = true; w.close(); } } catch {} });
        w.on("close", () => (ok ? res() : rej(new Error("closed before pong"))));
        w.on("error", (e) => rej(new Error("error:" + e.message)));
      });
      (async () => {
        const r = await withTimeout(rejected(base + "/admin-events"), 8000, "unauth");
        if (!/^close:4401$|^error$/.test(r)) throw new Error("no-token not rejected (" + r + ")");
        await withTimeout(pinged(base + "/admin-events?token=" + encodeURIComponent(token)), 8000, "auth");
      })().then(() => process.exit(0)).catch((e) => { console.error("       WS: " + e.message); process.exit(1); });
    ' "$WS_BASE" "$TOKEN"; then
      pass "no-token → rejected (4401); token → ping/pong"
    else
      fail "WebSocket check failed (see WS: line for the failing step)"
    fi
  else
    skip "WS test (node + ws not resolvable — run from the backend dir)"
  fi
fi

# ── summary ──────────────────────────────────────────────────────────────────
group "Summary"
printf '  %s%d passed%s · %s%d failed%s · %s%d skipped%s\n' "$G" "$PASS" "$N" "$R" "$FAIL" "$N" "$Y" "$SKIP" "$N"
[ "$FAIL" -eq 0 ]
