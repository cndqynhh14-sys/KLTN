# QLCL Dashboard

Node.js/Express application for the WCM QLCL quality-control workflow, including supplier data, evaluation tickets, scoring, approvals, OTP login, report export, and dashboard screens.

## Requirements

- Node.js 20 or newer
- npm
- Redis for production OTP storage
- SQLite database file at `data/qlcl.db` unless `DB_PATH` is overridden

## Local Setup

```bash
npm ci
cp .env.example .env
npm run build
npm start
```

The app listens on `0.0.0.0:3005` by default. Set `HOST` and `PORT` in `.env` to change it.

## Validation

```bash
npm test
npm run build
```

GitHub Actions runs the same test and build gates on pushes to `main`, `master`, and `codex-update-qlcl`, plus pull requests targeting `main`.

## Configuration

Required production settings:

- `JWT_SECRET`
- `ADMIN_EMAILS`
- `REDIS_URL`
- Email provider settings for SMTP or Microsoft Graph

Use `.env.example` as the starting point. Do not commit real `.env` secrets.

Email setup details live in `docs/email-otp-setup.md`.

## Deployment Notes

Railway test deployment is configured with:

- `Dockerfile`
- `railway.json`
- `docs/railway-deploy.md`

Use a Railway Volume mounted at `/data` and set `DATA_DIR=/data` so SQLite, uploads, and exports persist across deploys.

The app URL path is `/qlcl/`.

### Existing VM Deploy

The `deploy/` folder contains the current Linux service and nginx snippets:

- `deploy/deploy.sh`
- `deploy/qlcl.service`
- `deploy/nginx-qlcl.snippet`

The service expects the app under `/home/adminuser/qlcl` and proxies `/qlcl` to `127.0.0.1:3005`.
