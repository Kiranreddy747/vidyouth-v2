# One-shot: bring the whole stack live using portable Postgres + Redis.
# No admin, no Docker. Uses the same backend code that ships to AWS ECR.
#
#   cd "c:\data collection\vidyouth-login-backend"
#   Set-ExecutionPolicy -Scope Process Bypass -Force
#   .\scripts\start-local-stack.ps1
#
# Stops with: .\scripts\stop-local-stack.ps1

$ErrorActionPreference = "Stop"
$root      = "c:\data collection\runtime"
$pgBin     = Join-Path $root "pgsql\bin"
$pgData    = Join-Path $root "pgdata"
$pgLog     = Join-Path $root "postgres.log"
$redisExe  = Join-Path $root "redis\redis-server.exe"
$backend   = Split-Path -Parent $PSScriptRoot
$app       = Join-Path $backend "app"
$secretsDir = Join-Path $backend "secrets"

function Read-DotEnvValue($path, $name) {
  if (-not (Test-Path $path)) { return $null }
  $line = Get-Content $path | Where-Object {
    $_ -match "^\s*$([regex]::Escape($name))\s*="
  } | Select-Object -First 1
  if (-not $line) { return $null }
  $value = ($line -split "=", 2)[1].Trim()
  if ($value.Length -ge 2 -and (
      ($value.StartsWith('"') -and $value.EndsWith('"')) -or
      ($value.StartsWith("'") -and $value.EndsWith("'"))
    )) {
    $value = $value.Substring(1, $value.Length - 2)
  }
  return $value
}

function Format-DotEnvLine($name, $value) {
  if ([string]::IsNullOrWhiteSpace($value)) { return "" }
  $escaped = $value.Replace("\", "\\").Replace('"', '\"').Replace("`r", "\r").Replace("`n", "\n")
  return "$name=""$escaped"""
}

# 1. Sanity check that the portable binaries are extracted.
if (-not (Test-Path "$pgBin\pg_ctl.exe")) { throw "Postgres binaries missing at $pgBin. Run scripts\install-portable-runtime.ps1 first." }
if (-not (Test-Path $redisExe))            { throw "Redis binary missing at $redisExe. Run scripts\install-portable-runtime.ps1 first." }

# 2. Start Postgres if not already up.
if (-not (Get-NetTCPConnection -State Listen -LocalPort 5432 -ErrorAction SilentlyContinue)) {
  Write-Host "Starting Postgres..." -ForegroundColor Cyan
  & "$pgBin\pg_ctl.exe" -D $pgData -l $pgLog -o "-p 5432" start | Out-Null
  Start-Sleep -Seconds 3
}
Write-Host "Postgres: 127.0.0.1:5432" -ForegroundColor Green

# 3. Start Redis if not already up.
if (-not (Get-NetTCPConnection -State Listen -LocalPort 6379 -ErrorAction SilentlyContinue)) {
  Write-Host "Starting Redis..." -ForegroundColor Cyan
  Start-Process -FilePath $redisExe -ArgumentList "--port","6379","--protected-mode","no" -WindowStyle Hidden
  Start-Sleep -Seconds 2
}
Write-Host "Redis: 127.0.0.1:6379" -ForegroundColor Green

# 4. JWT keys.
if (-not (Test-Path "$secretsDir\jwt-private.pem") -or -not (Test-Path "$secretsDir\jwt-public.pem")) {
  if (-not (Test-Path $secretsDir)) { New-Item -ItemType Directory $secretsDir | Out-Null }
  Write-Host "Generating JWT RSA keypair..." -ForegroundColor Cyan
  node -e "const c=require('crypto');c.generateKeyPair('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}},(e,pub,priv)=>{if(e){console.error(e);process.exit(1);}require('fs').writeFileSync('$($secretsDir.Replace('\','/'))/jwt-private.pem',priv);require('fs').writeFileSync('$($secretsDir.Replace('\','/'))/jwt-public.pem',pub);});"
}

# 5. .env (multiline PEM works with dotenv >=15).
$priv = (Get-Content "$secretsDir\jwt-private.pem" -Raw).TrimEnd("`r","`n")
$pub  = (Get-Content "$secretsDir\jwt-public.pem"  -Raw).TrimEnd("`r","`n")
$rootEnv = Join-Path $backend ".env"
$oauthEnvContent = @(
  Format-DotEnvLine "GOOGLE_CLIENT_ID" (Read-DotEnvValue $rootEnv "GOOGLE_CLIENT_ID")
  Format-DotEnvLine "GOOGLE_CLIENT_SECRET" (Read-DotEnvValue $rootEnv "GOOGLE_CLIENT_SECRET")
  Format-DotEnvLine "GOOGLE_REDIRECT_URI" (Read-DotEnvValue $rootEnv "GOOGLE_REDIRECT_URI")
  Format-DotEnvLine "MICROSOFT_CLIENT_ID" (Read-DotEnvValue $rootEnv "MICROSOFT_CLIENT_ID")
  Format-DotEnvLine "MICROSOFT_CLIENT_SECRET" (Read-DotEnvValue $rootEnv "MICROSOFT_CLIENT_SECRET")
  Format-DotEnvLine "MICROSOFT_TENANT_ID" (Read-DotEnvValue $rootEnv "MICROSOFT_TENANT_ID")
  Format-DotEnvLine "MICROSOFT_REDIRECT_URI" (Read-DotEnvValue $rootEnv "MICROSOFT_REDIRECT_URI")
) | Where-Object { $_ }
$envContent = @"
NODE_ENV=development
PORT=8080
LOG_LEVEL=info
DATABASE_URL=postgres://vidyouth:devpass@127.0.0.1:5432/vidyouth_lms
REDIS_URL=redis://127.0.0.1:6379
REDIS_KEY_PREFIX=vidyouth:dev:
JWT_ISSUER=vidyouth.auth
JWT_AUDIENCE=vidyouth.lms
JWT_ACCESS_TTL_SECONDS=900
JWT_REFRESH_TTL_SECONDS=2592000
BCRYPT_ROUNDS=12
BCRYPT_PEPPER=dev-pepper-replace-in-prod-32chars
LOCKOUT_MAX_FAILED=5
LOCKOUT_WINDOW_SECONDS=1800
LOCKOUT_DURATION_SECONDS=1800
SESSION_MAX_PER_USER=3
OTP_TTL_SECONDS=600
OTP_LENGTH=6
OTP_RATE_LIMIT_WINDOW_SECONDS=600
OTP_RATE_LIMIT_MAX=5
SMS_PROVIDER=mock
EMAIL_PROVIDER=mock
EMAIL_FROM=no-reply@vidyouth.local
APP_BASE_URL=http://localhost:8080
EMAIL_VERIFICATION_TTL_SECONDS=86400
PASSWORD_RESET_TTL_SECONDS=3600
AWS_REGION=ap-south-1
SES_FROM_EMAIL=no-reply@vidyouth.local
SNS_SMS_TYPE=Transactional
JWT_PRIVATE_KEY="$priv"
JWT_PUBLIC_KEY="$pub"
$($oauthEnvContent -join "`n")
"@
[System.IO.File]::WriteAllText("$app\.env", $envContent, (New-Object System.Text.UTF8Encoding $false))

# 6. Start the API.
if (Get-NetTCPConnection -State Listen -LocalPort 8080 -ErrorAction SilentlyContinue) {
  Write-Host "API already listening on 8080. Skipping start." -ForegroundColor Yellow
} else {
  Write-Host "Starting API (npm run dev)..." -ForegroundColor Cyan
  Push-Location $app
  Start-Process -FilePath "powershell.exe" `
    -ArgumentList "-NoProfile","-NoExit","-Command","cd '$app'; npm run dev" `
    -WindowStyle Normal
  Pop-Location
  for ($i = 0; $i -lt 30; $i++) {
    try {
      $r = Invoke-WebRequest -Uri http://localhost:8080/livez -UseBasicParsing -TimeoutSec 2
      if ($r.StatusCode -eq 200) { break }
    } catch { Start-Sleep -Seconds 2 }
  }
}
Write-Host "API: http://localhost:8080" -ForegroundColor Green

# 7. Print health + a sample signup so the user can see it's truly live.
Write-Host ""
Write-Host "GET /healthz" -ForegroundColor Cyan
(Invoke-WebRequest http://localhost:8080/healthz -UseBasicParsing).Content

Write-Host ""
Write-Host "Open login.html or signup.html in your browser. The API pill should be GREEN."
