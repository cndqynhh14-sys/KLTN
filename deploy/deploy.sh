#!/usr/bin/env bash
# QLCL deploy: rsync local → VM, install deps, restart service, health check.
# Idempotent — safe to run repeatedly.
#
# Clone pattern từ CHT + bổ sung Step 0 pre-check (giống masan-rms deploy scripts
# sau ngày 2026-04-22): block uncommitted trong deployed paths, auto-pull rebase
# nếu local behind origin. Tránh race condition khi nhiều dev deploy song song.

set -euo pipefail

SSH_KEY="${SSH_KEY:-$HOME/.ssh/vm-risk-management-prod-sea-001.pem}"
SERVER="${SERVER:-10.191.147.4}"
USER="${SERVER_USER:-adminuser}"
REMOTE_DIR="/home/adminuser/qlcl"
NODE="/home/adminuser/.nvm/versions/node/v20.19.5/bin/node"

HERE="$(cd "$(dirname "$0")/.." && pwd)"

say() { printf '\033[1;34m[deploy]\033[0m %s\n' "$*"; }
ok()  { printf '\033[1;32m[ok]\033[0m %s\n' "$*"; }
warn(){ printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[err]\033[0m %s\n' "$*" >&2; exit 1; }

cd "$HERE"

# ============================================
# Step 0: CI/CD pre-checks (git sync + commit gate)
# ============================================
# Skip git checks if this folder isn't under git yet (repo chưa push lên GitHub
# trong lần deploy đầu). Dev bootstrap flow: clone qlcl → deploy → commit → push.
if [[ -d "$HERE/.git" ]]; then
  say "Step 0: CI/CD pre-checks"
  BRANCH=$(git rev-parse --abbrev-ref HEAD)

  # Deployed paths — gate chỉ áp dụng phạm vi rsync lên VM.
  DEPLOYED_PATHS="server public migrations database scripts deploy package.json package-lock.json tailwind.config.js src"

  DIRTY_TRACKED=$(git status --porcelain -- $DEPLOYED_PATHS 2>/dev/null | grep -v '^??' || true)
  DIRTY_UNTRACKED=$(git ls-files --others --exclude-standard -- $DEPLOYED_PATHS 2>/dev/null || true)
  if [[ -n "$DIRTY_TRACKED" || -n "$DIRTY_UNTRACKED" ]]; then
    printf '\033[1;31m[err]\033[0m Uncommitted changes trong deployed paths — commit trước khi deploy:\n'
    [[ -n "$DIRTY_TRACKED"   ]] && echo "$DIRTY_TRACKED"   | sed 's/^/     /'
    [[ -n "$DIRTY_UNTRACKED" ]] && echo "$DIRTY_UNTRACKED" | sed 's/^/     ?? /'
    echo ""
    printf '\033[1;33m💡\033[0m git add <files> && git commit -m "..."\n'
    exit 1
  fi

  say "Fetching latest from origin"
  git fetch origin "$BRANCH" --quiet || warn "Fetch failed — skipping sync check"

  if git rev-parse "origin/$BRANCH" >/dev/null 2>&1; then
    BEHIND=$(git rev-list HEAD.."origin/$BRANCH" --count)
    if [[ "$BEHIND" -gt 0 ]]; then
      warn "Local đang behind $BEHIND commit — auto-pulling từ origin/$BRANCH"
      git log HEAD.."origin/$BRANCH" --oneline | sed 's/^/     /'
      if ! git pull --rebase --autostash origin "$BRANCH"; then
        git rebase --abort 2>/dev/null || true
        die "Rebase conflict — deploy aborted. Resolve thủ công: git pull --rebase origin $BRANCH"
      fi
      ok "Pulled latest"
    fi
    AHEAD=$(git rev-list "origin/$BRANCH"..HEAD --count)
    [[ "$AHEAD" -gt 0 ]] && warn "Local đang ahead $AHEAD commit chưa push"
  fi
  LOCAL_COMMIT=$(git rev-parse --short HEAD)
  say "Deploying commit: $LOCAL_COMMIT"
else
  warn "Git repo chưa init — skipping pre-check. Init + push sau deploy đầu tiên."
fi

[[ -f "$HERE/.env" ]] || die "Missing .env at $HERE/.env (copy from .env.example)"

SSH="ssh -i $SSH_KEY -o StrictHostKeyChecking=no $USER@$SERVER"
# Exclude .env vì prod dùng USE_AZURE_KEYVAULT=true với Managed Identity của VM,
# local dev thường là fallback creds — không ghi đè prod .env.
# data/ là runtime: exclude toàn bộ thư mục để --delete không thể xóa database,
# attachments hoặc reports. Source schema/defaults được sync từ migrations/ và database/.
RSYNC_OPTS=(-avz --delete
  --exclude node_modules/ --exclude logs/
  --exclude 'data/'
  --exclude .git/ --exclude .env --exclude .env.example --exclude '*.md')

say "Building Tailwind CSS locally"
( cd "$HERE" && npm run build:css )

say "Ensuring remote dirs"
$SSH "mkdir -p $REMOTE_DIR/{data,logs}"

say "Checking prod .env exists on VM"
$SSH "test -f $REMOTE_DIR/.env" || die "Remote .env missing at $REMOTE_DIR/.env — tạo file này trước khi deploy"

say "Rsync source"
rsync -e "ssh -i $SSH_KEY -o StrictHostKeyChecking=no" "${RSYNC_OPTS[@]}" \
  "$HERE/" "$USER@$SERVER:$REMOTE_DIR/"

say "Installing dependencies on VM"
NODE_BIN_DIR="/home/adminuser/.nvm/versions/node/v20.19.5/bin"
$SSH "export PATH=$NODE_BIN_DIR:\$PATH && cd $REMOTE_DIR && npm ci --omit=dev"

say "Creating verified DB backup and running migration preflight on its disposable copy"
if ! PREFLIGHT_RESULT=$($SSH "export PATH=$NODE_BIN_DIR:\$PATH && cd $REMOTE_DIR && node scripts/preflight-deploy-migration.js"); then
  die "Database backup or migration preflight failed — live service was not restarted"
fi
[[ "$PREFLIGHT_RESULT" == *'"verified":true'* ]] || die "Database preflight did not return a verified result"
ok "Verified pre-deploy backup retained under runtime data; disposable migration copy passed"

say "Restarting service"
$SSH "sudo systemctl restart qlcl"
sleep 2
$SSH "sudo systemctl is-active --quiet qlcl" || die "Service failed to start — xem logs: $SSH \"sudo journalctl -u qlcl -n 50\""

say "Health check"
HEALTH=$($SSH "curl -fsS http://127.0.0.1:3005/health" || echo "FAILED")
[[ "$HEALTH" == *"ok"* ]] || die "Health check failed: $HEALTH"

ok "Deploy complete. URL: https://risk.masangrouptech.com/qlcl"
