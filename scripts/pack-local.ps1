# Pack → sync to release\local → restart LK Harness.
# Run DETACHED from Agent sessions, e.g.:
#   Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',"$PWD\scripts\pack-local.ps1" -WorkingDirectory $PWD
# Killing LK Harness will not kill this script if it was started detached.

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

# Agent/IDE 壳常把 PATH 堆满重复 .bin，嵌套 npm 时 CreateProcess 截断后会找不到 rimraf/npm
$machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($machinePath -or $userPath) {
  $env:Path = (@($machinePath, $userPath) | Where-Object { $_ }) -join ";"
}

$LogDir = Join-Path $Root "temp"
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }
$LogFile = Join-Path $LogDir ("pack-local-{0:yyyyMMdd-HHmmss}.log" -f (Get-Date))

function Write-Log([string]$msg) {
  $line = "[{0:HH:mm:ss}] {1}" -f (Get-Date), $msg
  Write-Host $line
  Add-Content -Path $LogFile -Value $line -Encoding UTF8
}

Write-Log "=== pack-local start ==="
Write-Log "root=$Root log=$LogFile"

try {
  Write-Log "1/4 npm run pack:win"
  # cmd /c 合流 stderr：npm 的 warn 走 stderr，Stop 偏好下会被当成 NativeCommandError 直接掐死任务，
  # 必须合并输出后仅按退出码判断；构建输出顺带落日志便于排障
  & cmd /c "npm run pack:win 2>&1" | Add-Content -Path $LogFile -Encoding UTF8
  if ($LASTEXITCODE -ne 0) { throw "pack:win failed exit=$LASTEXITCODE" }

  $src = Join-Path $Root "release\win-unpacked"
  $dst = Join-Path $Root "release\local"
  if (-not (Test-Path (Join-Path $src "LK Harness.exe"))) {
    throw "missing packed exe: $src\LK Harness.exe"
  }

  Write-Log "2/4 stop LK Harness"
  # CloseMainWindow 在 closeWindowAction=ask 时只弹窗不退出；用 --graceful-quit 第二实例触发 before-quit
  $procs = @(Get-Process -Name "LK Harness" -ErrorAction SilentlyContinue)
  if ($procs.Count -gt 0) {
    $exePath = $procs[0].Path
    Write-Log "  graceful-quit pid=$($procs[0].Id) exe=$exePath"
    try {
      Start-Process -FilePath $exePath -ArgumentList "--graceful-quit" -WindowStyle Hidden -ErrorAction Stop
    } catch {
      Write-Log "  graceful-quit spawn failed: $($_.Exception.Message)"
    }
  }
  $graceDeadline = (Get-Date).AddSeconds(25)
  while ((Get-Date) -lt $graceDeadline) {
    if (-not (Get-Process -Name "LK Harness" -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 500
  }
  $remaining = @(Get-Process -Name "LK Harness" -ErrorAction SilentlyContinue)
  if ($remaining.Count -gt 0) {
    Write-Log "  soft stop ($($remaining.Count) proc)"
    foreach ($p in $remaining) {
      Stop-Process -Id $p.Id -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 5
  }
  Get-Process -Name "LK Harness" -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Log "  force-kill pid=$($_.Id)"
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 1

  Write-Log "3/4 sync win-unpacked → local"
  if (-not (Test-Path $dst)) { New-Item -ItemType Directory -Path $dst | Out-Null }
  # /MIR: mirror; /R:2 /W:2: retry locked files; /NFL /NDL: quieter
  & robocopy $src $dst /MIR /R:3 /W:2 /NFL /NDL /NJH /NJS
  $rc = $LASTEXITCODE
  # robocopy: 0-7 success-ish, >=8 failure
  if ($rc -ge 8) { throw "robocopy failed exit=$rc" }
  Write-Log "  robocopy exit=$rc"

  $exe = Join-Path $dst "LK Harness.exe"
  if (-not (Test-Path $exe)) { throw "sync missing exe: $exe" }

  Write-Log "4/4 start $exe"
  Start-Process -FilePath $exe -WorkingDirectory $dst

  # 写通知标记：应用启动后主用户私聊会收到「新版已启动」
  $notify = Join-Path $env:APPDATA "lk-harness\pack-notify.json"
  $ver = "unknown"
  try {
    $pkg = Get-Content (Join-Path $Root "package.json") -Raw | ConvertFrom-Json
    if ($pkg.version) { $ver = [string]$pkg.version }
  } catch {}
  @{ version = $ver; packedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); log = $LogFile } |
    ConvertTo-Json -Compress | ForEach-Object {
      [System.IO.File]::WriteAllText($notify, $_, [System.Text.UTF8Encoding]::new($false))
    }
  Write-Log "  pack-notify written: $notify ver=$ver"

  Write-Log "=== pack-local done ==="
  exit 0
} catch {
  Write-Log "FAILED: $($_.Exception.Message)"
  exit 1
}
