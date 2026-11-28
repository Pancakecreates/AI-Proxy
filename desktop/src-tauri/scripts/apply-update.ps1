param(
    [string]$InstallerPath,
    [string]$AppExePath,
    [int]$AppPid
)

$logFile = Join-Path $env:TEMP 'ai-proxy-update.log'
function Write-Ulog([string]$msg) {
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -Path $logFile -Value "$stamp  $msg" -ErrorAction SilentlyContinue
}

Write-Ulog "=== update started: installer='$InstallerPath' exe='$AppExePath' pid=$AppPid ==="

if (-not (Test-Path -LiteralPath $InstallerPath)) {
    Write-Ulog "ERROR: installer not found, aborting"
    exit 1
}

# 1. Grace period: wait for the app to exit on its own (up to 20s).
$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline) {
    if (-not (Get-Process -Id $AppPid -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 300
}

# 2. Force kill if it is still alive after the grace period.
if (Get-Process -Id $AppPid -ErrorAction SilentlyContinue) {
    Write-Ulog "app pid $AppPid still alive after grace period, force killing"
    Stop-Process -Id $AppPid -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 700
} else {
    Write-Ulog "app exited"
}

# 3. Extra safety: kill leftover app instances running from the install dir.
if ($AppExePath) {
    $installDir = Split-Path -Parent $AppExePath
    $exeName = Split-Path -Leaf $AppExePath
    Get-CimInstance Win32_Process -Filter "Name='$exeName'" -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($installDir, [System.StringComparison]::OrdinalIgnoreCase) } |
        ForEach-Object {
            Write-Ulog "killing leftover instance pid=$($_.ProcessId)"
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
}

# 4. Run the installer silently and capture its exit code.
Write-Ulog "running installer"
$exitCode = -1
try {
    $p = Start-Process -FilePath $InstallerPath -ArgumentList '/S' -Wait -PassThru -WindowStyle Hidden
    $exitCode = $p.ExitCode
} catch {
    Write-Ulog "installer failed to start: $($_.Exception.Message)"
}
Write-Ulog "installer exit code: $exitCode"

Start-Sleep -Milliseconds 500

# 5. Relaunch the app. Primary target is the exact exe we were running from;
# the install location does not change across versions for per-user installs.
$target = $AppExePath
if (-not (Test-Path -LiteralPath $target)) {
    $exeLeaf = Split-Path -Leaf $AppExePath
    $fallback = Join-Path $env:LOCALAPPDATA "AI Proxy\$exeLeaf"
    if (Test-Path -LiteralPath $fallback) {
        Write-Ulog "primary path missing, using fallback '$fallback'"
        $target = $fallback
    }
}
if ($target -and (Test-Path -LiteralPath $target)) {
    $launched = $false
    foreach ($attempt in 1..2) {
        try {
            $np = Start-Process -FilePath $target -PassThru -ErrorAction Stop
            Write-Ulog "relaunched '$target' as pid $($np.Id)"
            $launched = $true
            break
        } catch {
            Write-Ulog "relaunch attempt $attempt failed: $($_.Exception.Message)"
            Start-Sleep -Milliseconds 1200
        }
    }
    if (-not $launched) {
        Write-Ulog "ERROR: could not relaunch the app"
    }
} else {
    Write-Ulog "ERROR: no app exe found to relaunch"
}

# 6. Clean up the downloaded installer payload.
Remove-Item -LiteralPath $InstallerPath -Force -ErrorAction SilentlyContinue
Write-Ulog "=== update script finished ==="
