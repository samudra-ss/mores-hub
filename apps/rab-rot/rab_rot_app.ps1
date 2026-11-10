# MORES RAB ROT - open the app in its own window, like an installed program.
#
#   rab_rot_app.ps1         start the app if it is not running, open its window
#   rab_rot_app.ps1 -Stop   stop the background app
#
# The server runs hidden (no console window); its log goes to
# %LOCALAPPDATA%\MORES RAB ROT\. The window is Microsoft Edge (or Chrome) in
# app mode: no tabs, no address bar, its own taskbar icon.
param([switch]$Stop)

$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Port = 8100
$Base = "http://127.0.0.1:$Port"
$LogDir = Join-Path $env:LOCALAPPDATA "MORES RAB ROT"

function Say($msg) {
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show($msg, "MORES RAB ROT")
}

function Test-App {
    # is MORES RAB ROT itself answering on the port (not some other program)?
    try {
        $r = Invoke-RestMethod -Uri "$Base/api/health" -TimeoutSec 2
        return ($r.app -eq "MORES RAB ROT")
    } catch { return $false }
}

function Test-Port {
    $c = New-Object System.Net.Sockets.TcpClient
    try { $c.Connect("127.0.0.1", $Port); return $true } catch { return $false } finally { $c.Close() }
}

if ($Stop) {
    $procId = $null
    try { $procId = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1).OwningProcess } catch { }
    if (-not $procId) { Say "MORES RAB ROT is not running."; exit 0 }
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -match '^(python|pythonw|py)$') {
        Stop-Process -Id $procId -Force
        Say "MORES RAB ROT stopped."
    } else {
        Say "Port $Port is used by '$($p.ProcessName)', not MORES RAB ROT - left alone."
    }
    exit 0
}

# 1. the app's server: start it hidden unless it already runs
if (-not (Test-App)) {
    if (Test-Port) {
        Say "Port $Port is taken by another program. Close it, or set another port, then try again."
        exit 1
    }
    $py = (Get-Command python -ErrorAction SilentlyContinue).Source
    $pyArgs = @("app.py")
    if (-not $py -or $py -match 'WindowsApps') {        # the Store alias only opens the Store
        $launcher = (Get-Command py -ErrorAction SilentlyContinue).Source
        if ($launcher) { $py = $launcher; $pyArgs = @("-3", "app.py") }
    }
    if (-not $py) {
        Say "Python was not found. Install Python 3 from python.org (tick 'Add python.exe to PATH'), then double-click install.bat in the rab-rot folder."
        exit 1
    }
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
    Start-Process -FilePath $py -ArgumentList $pyArgs -WorkingDirectory $Here -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $LogDir "server.log") -RedirectStandardError (Join-Path $LogDir "server-error.log")
    $deadline = (Get-Date).AddSeconds(30)
    while (-not (Test-App)) {
        if ((Get-Date) -gt $deadline) {
            Say "MORES RAB ROT did not start within 30 seconds. See the log:`n$LogDir\server-error.log`n`nIf it says 'No module named flask', double-click install.bat first."
            exit 1
        }
        Start-Sleep -Milliseconds 400
    }
}

# 2. the window: Edge or Chrome in app mode, else the default browser
$url = "$Base/"
$browsers = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$browser = $browsers | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if ($browser) {
    Start-Process -FilePath $browser -ArgumentList "--app=$url", "--window-size=1440,900"
} else {
    Start-Process $url
}
