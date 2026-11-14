# Staging tester OTP

Lets approved testers register and sign in on **Mator Staging** with phone OTP,
without real SMS, and only for their own numbers. Code:
`src/auth/phone/staging-otp.config.ts` (rules), `staging-otp.policy.ts`
(identity), `otp.service.ts` (the hooks), `staging-otp.controller.ts` (inbox).

## How it works

1. Nginx accepts a request only with a valid per-tester `X-Mator-Staging-Access`
   token (or Basic Auth for browsers). It maps the token to a **tester id**, drops
   the token, and sets two headers on the proxied request:
   `X-Mator-Staging-Tester: <id>` and `X-Mator-Staging-Proxy-Auth: <secret>`.
   Both replace anything the client sent.
2. The backend trusts the tester id only when the proxy secret matches
   (constant-time) and the id is in `STAGING_OTP_TESTERS`, which binds each id to
   its phone numbers. A phone number sent by the app proves nothing.
3. The ordinary `OtpService` issues, resends, verifies and rate-limits codes
   (6 digits, 5 min, 60 s resend cooldown, 5 attempts per request, 10 per phone
   per hour). With staging OTP on:
   - request, resend and verify are refused with `403 STAGING_OTP_NOT_ALLOWED`
     unless the caller is a tester bound to that number. Nothing is generated,
     stored or queued for any other number;
   - no SMS is queued. The code is sealed (AES-256-GCM, `OTP_JOB_ENCRYPTION_KEY`,
     bound to tester + slot + phone) in Redis until it expires;
   - it is never logged and never in the request/verify response.
4. The tester reads their own pending codes:
   `GET /v1/staging/otp/inbox` → `{ items: [{ request_id, phone, purpose, code, expires_at }] }`,
   `Cache-Control: no-store`. 404 for anyone else, and everywhere it is off.

## Environment (staging `.env`, values not shown)

| Variable | Value |
|---|---|
| `NODE_ENV` | `staging` (required; `production` refuses to boot with the switch on) |
| `STAGING_OTP_ENABLED` | `true` |
| `STAGING_OTP_TESTERS` | `tester-01=+998XXXXXXXXX,tester-02=+998XXXXXXXXX\|+998YYYYYYYYY` — lower-case ids, E.164 numbers, a number belongs to one tester |
| `STAGING_PROXY_SECRET` | ≥ 32 random characters (`openssl rand -hex 32`), shared with Nginx only |
| `OTP_JOB_ENCRYPTION_KEY` | 64 hex characters (`openssl rand -hex 32`); a staging-only key |
| `AUTH_DEV_MODE` | `false` (boot refuses both on) |
| `SMS_PROVIDER` | `log` (unchanged; no SMS leaves staging) |
| `DATABASE_URL` | the staging database; boot refuses database name `mator` |

Anything incomplete makes boot fail with a message naming the variable. A
process that somehow starts with an incomplete set grants nobody.

## Nginx (extends `docs/staging/ios-staging.md` in the app repo)

```nginx
# http {} — e.g. /etc/nginx/conf.d/mator-staging-access.conf
map $http_x_mator_staging_access $mator_staging_tester {
    default "";
    include /etc/nginx/mator-staging-access.map;   # root:root 0600
}
# The proxy secret is sent only with a vouched-for tester.
map $mator_staging_tester $mator_staging_proxy_auth {
    ""      "";
    include /etc/nginx/mator-staging-proxy-secret.map;   # root:root 0600: default "<STAGING_PROXY_SECRET>";
}
```

```nginx
# /etc/nginx/mator-staging-access.map — one line per tester; revoke by deleting
# "<openssl rand -hex 32>" tester-01;
```

```nginx
# server { server_name api.staging.mator.uz; … }
location = /_mator_staging_gate {
    internal;
    if ($mator_staging_tester) { return 204; }
    return 401;
}

# EVERY proxied location, including the WebSocket one. A location that sets any
# proxy_set_header does not inherit the server's, so repeat these in each.
location / {
    satisfy any;
    auth_basic "Mator Staging";
    auth_basic_user_file /etc/nginx/.htpasswd-mator-staging;
    auth_request /_mator_staging_gate;

    proxy_set_header X-Mator-Staging-Access     "";
    proxy_set_header X-Mator-Staging-Tester     $mator_staging_tester;
    proxy_set_header X-Mator-Staging-Proxy-Auth $mator_staging_proxy_auth;
    # … existing proxy_pass / headers unchanged …
}
```

`nginx -t && systemctl reload nginx`. Then confirm:

- the backend listens on `127.0.0.1:3001` only (`ss -ltnp | grep 3001`), so the
  headers can only come from Nginx;
- no `log_format` prints these headers;
- with a tester token, `GET /v1/staging/otp/inbox` answers 200 with `items: []`;
  with Basic Auth only, it answers 404.

## Tester flow

1. Sign in with your number in Mator Staging as usual.
2. Read the code: `curl -s -H "X-Mator-Staging-Access: $TOKEN" https://api.staging.mator.uz/v1/staging/otp/inbox`
   (an in-app "show staging code" button is a follow-up in the app repo).
3. Enter it. It is consumed, and leaves the inbox, on success.

## Revocation

- Immediate: delete the tester's line from the access map and reload Nginx. No
  further request carries their identity, so they can neither request, read nor
  redeem a code — including one issued before.
- Also remove them from `STAGING_OTP_TESTERS` (takes effect on restart).

## Production data

This mode only decides who may receive a phone code. It does not make a database
safe: `mator_staging` must never be restored from production. Before enabling,
check that the testers' numbers are not attached to anyone else's account there.
Apple, Google and email sign-in are not restricted by this mode.

## Security limitations

- The proxy secret is a static shared secret. Anyone who can read the Nginx
  config or the staging env can forge a tester identity — the same people who can
  read the token map already. Keep the backend on loopback.
- A tester token is a bearer credential for that tester's codes. A leaked token
  lets its holder sign in as that tester's numbers until it is revoked.
- Codes sit encrypted in staging Redis for at most 5 minutes; someone with both
  Redis and `OTP_JOB_ENCRYPTION_KEY` could read them.
- The inbox is limited only by the global request throttler.
