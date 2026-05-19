# Serve the static web pages (login / signup / reset-password / verify-email)
# on http://localhost:3000 so the links emailed by the API resolve.
#
# The API (start-local-stack.ps1) only speaks JSON on :8080. APP_BASE_URL is
# http://localhost:3000, so the reset/verify links need a static server here.
#
#   cd "d:\vidyouth-v2-master\vidyouth-login-backend"
#   Set-ExecutionPolicy -Scope Process Bypass -Force
#   .\scripts\start-frontend.ps1
#
# Stop with Ctrl+C. Bound to 127.0.0.1 ON PURPOSE: the repo root contains
# .env and secrets/, so it must not be reachable from the LAN.

$ErrorActionPreference = "Stop"

# Repo root = two levels up from this script (scripts -> backend -> repo root).
$webRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path

if (-not (Test-Path (Join-Path $webRoot "reset-password\index.html"))) {
  throw "Could not find reset-password\index.html under $webRoot. Run this script from its original location."
}

if (Get-NetTCPConnection -State Listen -LocalPort 3000 -ErrorAction SilentlyContinue) {
  Write-Host "Port 3000 is already in use. Frontend may already be running." -ForegroundColor Yellow
  Write-Host "Open http://localhost:3000/login.html to check." -ForegroundColor Yellow
  return
}

Write-Host "Serving $webRoot" -ForegroundColor Cyan
Write-Host "Frontend:        http://localhost:3000/login" -ForegroundColor Green
Write-Host "Reset password:  http://localhost:3000/reset-password?token=..." -ForegroundColor Green
Write-Host "Verify email:    http://localhost:3000/verify-email?token=..." -ForegroundColor Green
Write-Host "API expected at: http://localhost:8080  (run scripts\start-local-stack.ps1)" -ForegroundColor DarkGray
Write-Host "Ctrl+C to stop." -ForegroundColor DarkGray
Write-Host ""

# Hardened Node server: 127.0.0.1 only, blocks vidyouth-login-backend/.env,
# secrets/, .git/, dotfiles, and rejects foreign Host headers. No npx download.
node (Join-Path $PSScriptRoot "serve-frontend.mjs")
