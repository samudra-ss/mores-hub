# MORES HV - open the app in its own window, like an installed program.
#
#   mores_hv_app.ps1            start the server if it is not running, open MORES HV
#   mores_hv_app.ps1 -Open rab  ... straight into Remuneration > RAB ROT plan
#   mores_hv_app.ps1 -Stop      stop the background server
#
# The server runs hidden (no console window); its log goes to
# %LOCALAPPDATA%\MORES HV\server.log. The window is Microsoft Edge (or
# Chrome) in app mode: no tabs, no address bar, its own taskbar icon.
param([string]$Open = "", [switch]$Stop)

$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Port = 8000
$Base = "http://127.0.0.1:$Port"
$LogDir = Join-Path $env:LOCALAPPDATA "MORES HV"

function Say($msg) {
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show($msg, "MORES HV")
}

function Test-Port {
    $c = New-Object System.Net.Sockets.TcpClient
    try { $c.Connect("127.0.0.1", $Port); return $true } catch { return $false } finally { $c.Close() }
}

function Get-ServerPid {
    try { (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1).OwningProcess }
    catch { $null }
}

if ($Stop) {
    $procId = Get-ServerPid
    if (-not $procId) { Say "MORES HV is not running."; exit 0 }
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -match '^(python|pythonw|py)$') {
        Stop-Process -Id $procId -Force
        Say "MORES HV server stopped."
    } else {
        Say "Port $Port is used by '$($p.ProcessName)', not MORES HV - left alone."
    }
    exit 0
}

# 1. the server: start it hidden unless it already runs
if (-not (Test-Port)) {
    $py = (Get-Command python -ErrorAction SilentlyContinue).Source
    $pyArgs = @("server.py")
    if (-not $py -or $py -match 'WindowsApps') {        # the Store alias only opens the Store
        $launcher = (Get-Command py -ErrorAction SilentlyContinue).Source
        if ($launcher) { $py = $launcher; $pyArgs = @("-3", "server.py") }
    }
    if (-not $py) {
        Say "Python was not found. Install Python 3 from python.org (tick 'Add python.exe to PATH'), then run:`n`n  pip install -r requirements.txt`n`nin the apps\erp folder."
        exit 1
    }
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
    Start-Process -FilePath $py -ArgumentList $pyArgs -WorkingDirectory $Here -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $LogDir "server.log") -RedirectStandardError (Join-Path $LogDir "server-error.log")
    $deadline = (Get-Date).AddSeconds(30)
    while (-not (Test-Port)) {
        if ((Get-Date) -gt $deadline) {
            Say "MORES HV did not start within 30 seconds. See the log:`n$LogDir\server-error.log"
            exit 1
        }
        Start-Sleep -Milliseconds 400
    }
}

# 2. the window: Edge or Chrome in app mode, else the default browser
$url = if ($Open) { "$Base/app?open=$Open" } else { "$Base/app" }
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
