# Dev 模式：build → graceful-quit → 重启 electron-vite dev
# 必须从 Agent 会话 detached 启动，否则杀 Electron 会掐掉 Agent：
#   npm run dev:restart
#   node scripts/dev-restart-detached.cjs

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($machinePath -or $userPath) {
  $env:Path = (@($machinePath, $userPath) | Where-Object { $_ }) -join ";"
}

$LogDir = Join-Path $Root "temp"
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }
$LogFile = Join-Path $LogDir ("dev-restart-{0:yyyyMMdd-HHmmss}.log" -f (Get-Date))

function Write-Log([string]$msg) {
  $line = "[{0:HH:mm:ss}] {1}" -f (Get-Date), $msg
  Write-Host $line
  Add-Content -Path $LogFile -Value $line -Encoding UTF8
}

function Get-LkHarnessElectronProcs() {
  Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'lk-harness' }
}

function Get-LkHarnessViteDevProcs() {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'lk-harness' -and $_.CommandLine -match 'electron-vite' }
}

Write-Log "=== dev-restart start ==="
Write-Log "root=$Root log=$LogFile"

# 启动后由 consumeRestartNotify 读此文件并 confirm-all-claimed（与 pack-notify.json 同机制）
$notify = Join-Path $env:APPDATA "lk-harness\dev-restart-notify.json"
try {
  $ver = "unknown"
  try {
    $pkg = Get-Content (Join-Path $Root "package.json") -Raw | ConvertFrom-Json
    if ($pkg.version) { $ver = [string]$pkg.version }
  } catch {}
  @{ version = $ver; restartedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); log = $LogFile } |
    ConvertTo-Json -Compress | ForEach-Object {
      [System.IO.File]::WriteAllText($notify, $_, [System.Text.UTF8Encoding]::new($false))
    }
  Write-Log "dev-restart-notify written: $notify ver=$ver"
} catch {
  Write-Log "WARN: dev-restart-notify write failed: $($_.Exception.Message)"
}

try {
  Write-Log "1/4 npm run build:bundle"
  & cmd /c "npm run build:bundle 2>&1" | Add-Content -Path $LogFile -Encoding UTF8
  if ($LASTEXITCODE -ne 0) { throw "build:bundle failed exit=$LASTEXITCODE" }

  Write-Log "2/4 npx electron-vite build"
  & cmd /c "npx electron-vite build 2>&1" | Add-Content -Path $LogFile -Encoding UTF8
  if ($LASTEXITCODE -ne 0) { throw "electron-vite build failed exit=$LASTEXITCODE" }

  Write-Log "3/4 stop lk-harness (graceful-quit → force)"
  $electronExe = Join-Path $Root "node_modules\electron\dist\electron.exe"
  $mainProcs = @(Get-LkHarnessElectronProcs | Where-Object { $_.CommandLine -match 'electron\.exe \.' })
  if ($mainProcs.Count -gt 0 -and (Test-Path $electronExe)) {
    Write-Log "  graceful-quit pid=$($mainProcs[0].ProcessId)"
    try {
      Start-Process -FilePath $electronExe -ArgumentList ".", "--graceful-quit" -WorkingDirectory $Root -WindowStyle Hidden -ErrorAction Stop
    } catch {
      Write-Log "  graceful-quit spawn failed: $($_.Exception.Message)"
    }
  }
  $graceDeadline = (Get-Date).AddSeconds(25)
  while ((Get-Date) -lt $graceDeadline) {
    if (-not (Get-LkHarnessElectronProcs)) { break }
    Start-Sleep -Milliseconds 500
  }
  foreach ($p in @(Get-LkHarnessViteDevProcs)) {
    Write-Log "  stop electron-vite dev pid=$($p.ProcessId)"
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  }
  foreach ($p in @(Get-LkHarnessElectronProcs)) {
    Write-Log "  force-kill electron pid=$($p.ProcessId)"
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 2

  Write-Log "4/4 start npm run dev:live (detached window)"
  $devLog = Join-Path $LogDir ("dev-live-{0:yyyyMMdd-HHmmss}.log" -f (Get-Date))
  $startCmd = "Set-Location -LiteralPath '$($Root.Replace("'", "''"))'; npm run dev:live *>> '$($devLog.Replace("'", "''"))'"
  $viteProc = Start-Process -FilePath "powershell.exe" `
    -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $startCmd `
    -WorkingDirectory $Root -WindowStyle Hidden -PassThru
  Write-Log "  dev:live pid=$($viteProc.Id) log=$devLog"

  $readyDeadline = (Get-Date).AddSeconds(90)
  $lockFile = Join-Path $env:APPDATA "lk-harness\daemon.lock.json"
  $startedAtBefore = $null
  if (Test-Path $lockFile) {
    try {
      $startedAtBefore = (Get-Content $lockFile -Raw | ConvertFrom-Json).startedAt
    } catch {}
  }
  while ((Get-Date) -lt $readyDeadline) {
    Start-Sleep -Seconds 2
    if (Test-Path $lockFile) {
      try {
        $lock = Get-Content $lockFile -Raw | ConvertFrom-Json
        if ($lock.startedAt -and $lock.startedAt -ne $startedAtBefore -and $lock.port) {
          Write-Log "  daemon ready port=$($lock.port) pid=$($lock.pid) startedAt=$($lock.startedAt)"
          Write-Log "=== dev-restart done ==="
          exit 0
        }
      } catch {}
    }
    if ((Get-LkHarnessElectronProcs | Where-Object { $_.CommandLine -match 'electron\.exe \.' })) {
      Write-Log "  electron main up, waiting for daemon lock..."
    }
  }
  Write-Log "WARN: daemon lock not refreshed within 90s (dev may still be starting) log=$devLog"
  Write-Log "=== dev-restart done (pending) ==="
  exit 0
} catch {
  Write-Log "FAILED: $($_.Exception.Message)"
  exit 1
}
