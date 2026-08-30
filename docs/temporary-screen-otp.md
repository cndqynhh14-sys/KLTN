# Temporary screen OTP

Temporary screen OTP is a degraded authentication delivery mode for a short,
approved window while email delivery is unavailable. It is not a development
bypass and must not become a permanent hosted configuration.

## Ownership and deadline

- Owner: the named Security/IAM deployment owner recorded in `SCREEN_OTP_OWNER`.
  Use an accountable team mailbox or named on-call owner, not a generic value.
- Deadline: the exact ISO instant in `SCREEN_OTP_EXPIRES_AT`. The runtime checks
  it on every request and readiness check; an expired window disables screen
  delivery automatically. A single window cannot exceed seven days.
- Decision status: OTP-001 remains pending. Screen mode is OFF unless every
  guard below is valid.

## Configuration and enablement

### Local DEV convenience profile

Local development may use the explicit relaxed profile while email delivery is
not available:

```dotenv
NODE_ENV=development
APP_ENV=development
OTP_DELIVERY_MODE=screen
OTP_HMAC_SECRET=<distinct local secret of at least 32 bytes>
SCREEN_OTP_ENABLED=true
SCREEN_OTP_DEV_RELAXED=true
```

This profile removes the configuration-window expiry, owner and exact email
allow-list requirements for Masan-domain accounts in local DEV only. Individual
OTP sessions remain one-time, HMAC-verified, attempt-limited and TTL-bound. The
API/readiness response marks it as `development_relaxed` and
`productionReady=false`, and the UI displays a Go Live/PRD warning.

Before Go Live or changing `APP_ENV` to `PRD`, remove
`SCREEN_OTP_DEV_RELAXED` and activate every guarded-screen setting below, or
switch to `OTP_DELIVERY_MODE=email`. The runtime rejects the relaxed profile
when either `NODE_ENV=production` or `APP_ENV=PRD|production`.

Normal delivery:

```dotenv
OTP_DELIVERY_MODE=email
OTP_HMAC_SECRET=<distinct random secret of at least 32 bytes>
SCREEN_OTP_ENABLED=false
```

Temporary screen delivery:

```dotenv
OTP_DELIVERY_MODE=screen
OTP_HMAC_SECRET=<distinct random secret of at least 32 bytes>
SCREEN_OTP_ENABLED=true
SCREEN_OTP_EXPIRES_AT=2026-07-15T10:00:00.000Z
SCREEN_OTP_OWNER=security-iam-owner@example.com
SCREEN_OTP_ACCOUNT_SCOPE=allow_list
SCREEN_OTP_ALLOWED_EMAILS=approved.user@winmart.masangroup.com
```

The allow-list contains exact Masan email addresses only. Wildcards and domain-
wide entries are rejected. In production, also set the exact acknowledgement:

```dotenv
SCREEN_OTP_PRODUCTION_ACK=I_ACCEPT_TEMPORARY_SCREEN_OTP_RISK_UNTIL_EXPIRY
```

Production requires the mode, enable flag, owner, future deadline, distinct
HMAC secret, acknowledgement, and one explicit account scope. The default
`allow_list` scope also requires at least one exact Masan email. A boolean alone
cannot enable screen delivery. `OTP_DELIVERY_MODE=test` is accepted only when
`NODE_ENV=test` and never returns a screen code through the API.

When every active internal account in the application database must use the
temporary screen flow, use the database-backed scope instead of maintaining an
email list:

```dotenv
SCREEN_OTP_ACCOUNT_SCOPE=active_database_users
SCREEN_OTP_ALLOWED_EMAILS=
SCREEN_OTP_DATABASE_SCOPE_ACK=I_ACCEPT_TEMPORARY_SCREEN_OTP_FOR_ACTIVE_DATABASE_USERS_UNTIL_EXPIRY
```

This scope reads the `users` table for every OTP request. A newly created,
active Masan-domain account therefore works immediately without a deployment or
environment-variable change. Disabled and unknown accounts receive the same
public challenge shape but the challenge is non-eligible and can never create a
login session. Supplier-user accounts remain blocked by the internal portal
policy. Production requires both acknowledgements and all other guarded-screen
controls above.

Before enabling, record the incident/change reference, owner, account scope,
deadline, and rollback contact. For `allow_list`, record the exact email list as
well. Restart the service and require `/readiness` to return `ready`. To disable,
set `OTP_DELIVERY_MODE=email` and
`SCREEN_OTP_ENABLED=false`, remove the screen-only values, restart, and verify
email delivery plus `/readiness`.

## Data and security controls

- Redis or memory storage contains email eligibility, HMAC verifier, attempts,
  created time, and expiry only. It never contains the plaintext OTP.
- Verification uses a separate `OTP_HMAC_SECRET`, constant-time verifier
  comparison, TTL, maximum attempts, resend invalidation, and one-time deletion.
- Unknown or disabled in-domain accounts receive a non-eligible session with the
  same public response shape. A displayed fake code cannot authenticate.
- Codes appear only in a valid screen-mode JSON body and sensitive DOM callout.
  They are never placed in URLs, local/session storage, logs, telemetry, audit
  metadata, browser console output, UAT traces, or unmasked screenshots.
- Successful screen authentication shows the degraded-auth banner. Email mode
  does not show it.

## Monitoring

Monitor `/readiness`, HTTP 503 `otp_delivery_unavailable`, request/verify rate
limits, invalid/max-attempt counts, and the audit events
`auth.otp.request.degraded`, `auth.otp.delivery.unavailable`, and
`auth.login.degraded`. Alert before the configured deadline. In allow-list scope,
treat any request outside the exact list as an incident. In database scope,
monitor disabled/unknown attempts and unexpected degraded-login volume.
Audit metadata may contain safe delivery mode/reason values, never the code.

## Incident response

1. Set `SCREEN_OTP_ENABLED=false` and restart or roll back the deployment.
2. Revoke affected authenticated sessions and rotate `OTP_HMAC_SECRET` if code
   exposure or verifier compromise is suspected.
3. Preserve only redacted request IDs, correlation IDs, safe audit events, and
   configuration timestamps. Do not copy OTP values, Redis payloads, cookies,
   screenshots, or response bodies into tickets/evidence.
4. Review the exact email allow-list, actor history, rate-limit events, and
   degraded login window; notify the Security/IAM owner.
5. Restore `OTP_DELIVERY_MODE=email`, verify a mocked and real delivery path,
   and close the incident only after readiness and auth UAT pass.

## Removal criteria

Remove degraded mode configuration and code when email delivery has passed
staging/production monitoring for the agreed stability window, no approved user
still depends on screen delivery, all degraded sessions are expired/revoked,
and the Security/IAM owner closes the temporary exception. The final removal
must delete screen-specific environment variables, UI callout/banner paths,
screen response fields, and this operational exception from deployment docs.
