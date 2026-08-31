#requires -Version 5.1
<#!
.SYNOPSIS
  Gefuehrte, wiederholbare Windows-Installation fuer AI Trading Firm.
.DESCRIPTION
  Installiert Git, Node.js LTS, PostgreSQL und optional Ollama via winget,
  richtet Datenbank/.env ein, installiert npm-Abhaengigkeiten, Schema und
  Universe und prueft TypeScript, Lint, Build und Health.

  Paper-Trading bleibt immer aktiv. Dieses Skript aktiviert niemals Live-Trading.
  Secrets werden nicht geloggt. Bei einem Fehler erscheint ein konkreter Fix.
.EXAMPLE
  Set-ExecutionPolicy -Scope Process Bypass; .\scripts\setup-windows.ps1
.EXAMPLE
  .\scripts\setup-windows.ps1 -NonInteractive -SkipOllama
#>
[CmdletBinding()]
param(
  [switch]$NonInteractive,
  [switch]$SkipOllama,
  [switch]$SkipBuild,
  [switch]$SkipValidation,
  [switch]$KeepExistingEnv,
  [string]$DbName = "trading_firm",
  [string]$DbUser = "trader",
  [int]$DbPort = 5432,
  [string]$DbPassword,
  [string]$PostgresSuperPassword,
  [string]$LlmModel = "qwen2.5:3b-instruct-q4_K_M",
  [int]$AppPort = 3369
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$LogDir = Join-Path $Root "data\setup"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LogFile = Join-Path $LogDir ("setup-windows-{0}.log" -f (Get-Date -Format "yyyyMMdd-HHmmss"))
$Step = 0

function Write-Log([string]$Message, [ValidateSet("INFO","OK","WARN","ERROR")][string]$Level = "INFO") {
  $line = "{0} [{1}] {2}" -f (Get-Date -Format "s"), $Level, $Message
  Add-Content -LiteralPath $LogFile -Value $line
  switch ($Level) { "OK" { Write-Host "  [OK] $Message" -ForegroundColor Green }; "WARN" { Write-Host "  [!] $Message" -ForegroundColor Yellow }; "ERROR" { Write-Host "  [X] $Message" -ForegroundColor Red }; default { Write-Host "  -> $Message" } }
}
function Ask([string]$Question, [string]$Default = "N") {
  if ($NonInteractive) { return $Default.ToUpperInvariant() -eq "J" }
  $answer = Read-Host "$Question [J/N, Standard: $Default]"
  if ([string]::IsNullOrWhiteSpace($answer)) { $answer = $Default }
  return $answer -match "^(j|ja|y|yes)$"
}
function Ask-Secret([string]$Question, [string]$Value) {
  if ($Value) { return $Value }
  if ($NonInteractive) { throw "Fehlendes Secret: $Question. Interaktiv -NonInteractive entfernen oder Secret als Parameter uebergeben." }
  # ConvertFrom-SecureString -AsPlainText gibt es erst in PowerShell 7;
  # diese Variante funktioniert auch mit Windows PowerShell 5.1.
  $secure = Read-Host $Question -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}
function Step([string]$Title) { $script:Step++; Write-Host "`n===== Schritt $script:Step — $Title =====" -ForegroundColor Cyan; Write-Log "Schritt $script:Step — $Title" }
function Need([string]$Command, [string]$Fix) { if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) { throw "'$Command' fehlt. Fix: $Fix" } }
function Run([string]$File, [string[]]$Arguments, [string]$Fix) {
  $displayArgs = if ($File -match '^psql(\.exe)?$') { "[PostgreSQL-Kommando, Argumente/SQL redigiert]" } else { $Arguments -join " " }
  Write-Log ("Ausfuehren: {0} {1}" -f $File, $displayArgs)
  & $File @Arguments 2>&1 | Tee-Object -FilePath $LogFile -Append
  if ($LASTEXITCODE -ne 0) { throw "Befehl fehlgeschlagen (Exit $LASTEXITCODE). Fix: $Fix`nLog: $LogFile" }
}
function Winget-Install([string]$Id, [string]$Name) {
  if (Get-Command $Name -ErrorAction SilentlyContinue) { Write-Log "$Name ist bereits installiert." "OK"; return }
  Need "winget" "Windows App Installer aus dem Microsoft Store installieren oder die Pakete manuell installieren."
  Write-Log "$Name wird mit winget installiert."
  Run "winget" @("install","--id",$Id,"--exact","--accept-source-agreements","--accept-package-agreements") "winget install --id $Id; danach PowerShell neu starten und das Skript erneut ausfuehren."
}
function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $user = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$machine;$user;$env:Path"
  @("$env:ProgramFiles\nodejs", "$env:ProgramFiles\PostgreSQL\17\bin", "$env:ProgramFiles\PostgreSQL\16\bin", "$env:LOCALAPPDATA\Programs\Ollama") | ForEach-Object { if (Test-Path $_) { $env:Path = "$_;$env:Path" } }
}
function Escape-Sql([string]$Text) { return $Text.Replace("'", "''") }
function New-Token {
  $bytes = New-Object byte[] 36
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  return ([Convert]::ToBase64String($bytes)).Replace("+","-").Replace("/","_").TrimEnd("=")
}

try {
  Set-Location $Root
  Write-Host "AI Trading Firm — Windows Setup (Paper-Trading)" -ForegroundColor Green
  Write-Host "Projekt: $Root`nLog: $LogFile"
  if (-not (Ask "Nur Paper-Trading einrichten und Live-Trading sicher deaktiviert lassen?" "J")) { throw "Abgebrochen: Paper-Trading-Sicherheitsbestaetigung erforderlich." }

  Step "Voraussetzungen und Paketmanager"
  Need "winget" "Installiere 'App Installer' aus dem Microsoft Store. Alternativ installiere Git, Node.js LTS und PostgreSQL manuell und starte dieses Skript erneut."
  Winget-Install "Git.Git" "git"
  Winget-Install "OpenJS.NodeJS.LTS" "node"
  Refresh-Path
  Need "git" "PowerShell neu starten, damit Git im PATH sichtbar wird."
  Need "node" "Node.js LTS >= 20 von https://nodejs.org installieren und Skript erneut starten."
  Need "npm" "Node.js LTS reparieren/neu installieren; pruefe 'node --version' und 'npm --version'."
  $nodeMajor = [int]((node --version).TrimStart('v').Split('.')[0])
  if ($nodeMajor -lt 20) { throw "Node.js $nodeMajor ist zu alt. Fix: winget upgrade OpenJS.NodeJS.LTS, danach PowerShell neu starten." }
  Write-Log "Node.js $nodeMajor erkannt." "OK"

  Step "PostgreSQL installieren und Dienst starten"
  if (-not (Get-Command psql -ErrorAction SilentlyContinue)) {
    Winget-Install "PostgreSQL.PostgreSQL.17" "psql"
    Refresh-Path
  }
  Need "psql" "PostgreSQL 17 installieren: winget install --id PostgreSQL.PostgreSQL.17; danach PowerShell neu starten."
  $pgService = Get-Service | Where-Object { $_.Name -match '^postgresql.*' } | Select-Object -First 1
  if (-not $pgService) { throw "Kein PostgreSQL-Windowsdienst gefunden. Fix: PostgreSQL-Installer erneut ausfuehren und den Dienst 'postgresql-x64-17' aktivieren." }
  if ($pgService.Status -ne "Running") { Start-Service $pgService.Name; Start-Sleep -Seconds 2 }
  if ((Get-Service $pgService.Name).Status -ne "Running") { throw "PostgreSQL-Dienst laeuft nicht. Fix: Start-Service $($pgService.Name); pruefe Windows-Ereignisanzeige und Port $DbPort." }
  Write-Log "PostgreSQL-Dienst $($pgService.Name) laeuft." "OK"
  $PostgresSuperPassword = Ask-Secret "PostgreSQL-superuser Passwort" $PostgresSuperPassword
  $DbPassword = Ask-Secret "Passwort fuer Datenbankbenutzer '$DbUser'" $DbPassword
  if ($DbPassword.Length -lt 12) { throw "DB-Passwort muss mindestens 12 Zeichen haben. Fix: erneut mit -DbPassword oder interaktiv starten." }
  if ($DbName -notmatch '^[A-Za-z_][A-Za-z0-9_]*$' -or $DbUser -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { throw "DbName und DbUser duerfen nur Buchstaben, Zahlen und _ enthalten." }
  if ($DbPort -lt 1 -or $DbPort -gt 65535) { throw "DbPort muss zwischen 1 und 65535 liegen." }
  $env:PGPASSWORD = $PostgresSuperPassword
  $safeUser = Escape-Sql $DbUser; $safeDb = Escape-Sql $DbName; $safePass = Escape-Sql $DbPassword
  $roleSql = "DO `$`$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$safeUser') THEN CREATE ROLE $DbUser LOGIN PASSWORD '$safePass'; ELSE ALTER ROLE $DbUser WITH LOGIN PASSWORD '$safePass'; END IF; END `$`$;"
  Run "psql" @("-h","127.0.0.1","-p",$DbPort,"-U","postgres","-d","postgres","-v","ON_ERROR_STOP=1","-c",$roleSql) "PostgreSQL-Passwort, Dienst und Port pruefen: psql -h 127.0.0.1 -U postgres -d postgres."
  $dbExists = (& psql -h 127.0.0.1 -p $DbPort -U postgres -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$safeDb'" 2>>$LogFile).Trim()
  if ($dbExists -ne "1") { Run "psql" @("-h","127.0.0.1","-p",$DbPort,"-U","postgres","-d","postgres","-v","ON_ERROR_STOP=1","-c","CREATE DATABASE $DbName OWNER $DbUser;") "Datenbankname/Benutzer pruefen oder CREATE DATABASE manuell ausfuehren." }
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue

  Step ".env erzeugen (bestehende Werte werden geschuetzt)"
  $envFile = Join-Path $Root ".env"
  if ((Test-Path $envFile) -and $KeepExistingEnv) { Write-Log ".env wird unveraendert beibehalten (-KeepExistingEnv)." "OK" }
  else {
    if ((Test-Path $envFile) -and -not (Ask ".env existiert. Sichern und Setup-Werte aktualisieren?" "J")) { throw "Abgebrochen. Nutze -KeepExistingEnv fuer vorhandene Konfiguration." }
    if (Test-Path $envFile) { Copy-Item $envFile "$envFile.bak-$(Get-Date -Format yyyyMMdd-HHmmss)" }
    $encodedUser = [Uri]::EscapeDataString($DbUser); $encodedPass = [Uri]::EscapeDataString($DbPassword); $encodedDb = [Uri]::EscapeDataString($DbName)
    $token = New-Token
    @("DATABASE_URL=postgresql://$encodedUser`:$encodedPass@127.0.0.1`:$DbPort/$encodedDb", "LLM_PROVIDER=ollama", "OLLAMA_BASE_URL=http://127.0.0.1:11434", "OLLAMA_NUM_CTX=4096", "LLM_MAX_TOKENS=512", "LLM_TIMEOUT_MS=180000", "LLM_MAX_ATTEMPTS=2", "LLM_MODEL=$LlmModel", "STARTING_EQUITY=10000", "PAPER_MODE=broker-market-data", "PAPER_MODE_C_ENABLED=false", "REQUIRE_HUMAN_APPROVAL=true", "FIRM_API_TOKEN=$token", "LIVE_TRADING_ENABLED=false", "BITUNIX_ENABLED=false") | Set-Content -LiteralPath $envFile -Encoding UTF8
    Write-Log ".env erstellt (Secrets nicht ausgegeben)." "OK"
  }

  Step "npm-Abhaengigkeiten und Schema"
  Run "npm.cmd" @("ci") "Loesche node_modules und package-lock.json nicht. Fix: npm cache verify; danach npm ci erneut. Bei Proxy: npm config set proxy <URL>."
  Run "npx.cmd" @("drizzle-kit","push") "DATABASE_URL in .env und PostgreSQL-Verbindung pruefen; danach npx drizzle-kit push erneut."
  Run "npm.cmd" @("run","universe:seed:markets") "Schema zuerst einspielen; danach npm run universe:seed:markets erneut."
  Run "npm.cmd" @("run","universe:seed") "Schema zuerst einspielen; danach npm run universe:seed erneut."

  Step "Ollama (optional) und Modell"
  if (-not $SkipOllama -and (Ask "Ollama fuer lokalen LLM installieren und Modell '$LlmModel' laden?" "J")) {
    Winget-Install "Ollama.Ollama" "ollama"
    Refresh-Path
    if (Get-Command ollama -ErrorAction SilentlyContinue) {
      try { Run "ollama.exe" @("pull",$LlmModel) "Fix: ollama serve starten, Firewall erlauben und 'ollama pull $LlmModel' spaeter erneut ausfuehren." }
      catch { Write-Log $_.Exception.Message "WARN"; Write-Log "Ohne Modell kann die App starten, LLM-Agenten bleiben aber nicht verfuegbar." "WARN" }
    }
  } else { Write-Log "Ollama uebersprungen. Nutze spaeter einen Provider und setze LLM_PROVIDER/LLM_API_KEY in .env." "WARN" }

  if (-not $SkipBuild) {
    Step "Typecheck, Lint und Produktions-Build"
    Run "npm.cmd" @("run","typecheck") "TypeScript-Fehler beheben; npm run typecheck erneut ausfuehren."
    Run "npm.cmd" @("run","lint") "ESLint-Fehler beheben; npm run lint erneut ausfuehren."
    Run "npm.cmd" @("run","build") "Build-Log pruefen; zuerst npm ci und npm run build erneut."
  } else { Write-Log "Build uebersprungen (-SkipBuild)." "WARN" }

  if (-not $SkipValidation) {
    Step "Health-Check der Anwendung"
    $out = Join-Path $LogDir "next-start-$((Get-Date).ToString('yyyyMMdd-HHmmss')).log"
    # `npm run start` nutzt im package.json POSIX-PORT-Syntax; direktes Next-CLI
    # ist deshalb der portable Windows-Aufruf.
    $app = Start-Process -FilePath "npx.cmd" -ArgumentList @("next","start","-H","127.0.0.1","-p",$AppPort) -WorkingDirectory $Root -RedirectStandardOutput $out -RedirectStandardError (Join-Path $LogDir "next-start-stderr.log") -PassThru -WindowStyle Hidden
    try {
      $healthy = $false
      1..30 | ForEach-Object { Start-Sleep -Seconds 2; try { $r = Invoke-WebRequest "http://127.0.0.1:$AppPort/api/health" -UseBasicParsing -TimeoutSec 3; if ($r.StatusCode -eq 200) { $healthy = $true; break } } catch {} }
      if (-not $healthy) { throw "Health-Check http://127.0.0.1:$AppPort/api/health nicht erreichbar. Fix: Get-Content '$out'; pruefe Port, .env und PostgreSQL." }
      Write-Log "Health-Check erfolgreich: http://127.0.0.1:$AppPort/api/health" "OK"
    } finally { if ($app -and -not $app.HasExited) { Stop-Process -Id $app.Id -Force } }
  } else { Write-Log "Health-Check uebersprungen (-SkipValidation)." "WARN" }

  Write-Host "`nINSTALLATION ERFOLGREICH" -ForegroundColor Green
  Write-Host "Start: npm run start   (http://127.0.0.1:$AppPort)"
  Write-Host "Stop:  Ctrl+C bzw. Get-Process node | Stop-Process"
  Write-Host "Log:   $LogFile"
  Write-Host "Sicherheit: Paper-Trading aktiv, Human Approval aktiv, Live-Trading deaktiviert."
} catch {
  Write-Log $_.Exception.Message "ERROR"
  Write-Host "`nINSTALLATION ABGEBROCHEN — folge dem Fix oben und starte das Skript erneut." -ForegroundColor Red
  Write-Host "Vollstaendiges Log: $LogFile" -ForegroundColor Yellow
  exit 1
} finally { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }
