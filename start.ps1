<#
    AEROTWIN - one-command launch.

    Starts the FastAPI backend and the Vite dev server, waits for both to
    answer, and opens the ground station. Ctrl+C stops both.
#>

param(
    [int] $BackendPort  = 8011,
    [int] $FrontendPort = 5173,
    [switch] $NoBrowser
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

function Wait-ForPort([int] $Port, [string] $Label, [int] $TimeoutSeconds = 90) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
        if ($listening) { Write-Host "  $Label ready on port $Port" -ForegroundColor Green; return $true }
        Start-Sleep -Milliseconds 400
    }
    Write-Host "  $Label did not come up on port $Port" -ForegroundColor Red
    return $false
}

Write-Host "AEROTWIN - Propulsion Intelligence System" -ForegroundColor Cyan
Write-Host "Research prototype. Not certified for airworthiness decisions.`n"

if (-not (Test-Path (Join-Path $root 'frontend/node_modules'))) {
    Write-Host "Installing frontend dependencies..." -ForegroundColor Yellow
    Push-Location (Join-Path $root 'frontend'); npm install; Pop-Location
}

Write-Host "Starting twin backend..." -ForegroundColor Yellow
$backend = Start-Process -PassThru -WindowStyle Hidden -WorkingDirectory (Join-Path $root 'backend') `
    -FilePath 'python' -ArgumentList @('-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', "$BackendPort")

Write-Host "Starting ground station..." -ForegroundColor Yellow
$frontend = Start-Process -PassThru -WindowStyle Hidden -WorkingDirectory (Join-Path $root 'frontend') `
    -FilePath 'cmd' -ArgumentList @('/c', 'npm', 'run', 'dev', '--', '--port', "$FrontendPort")

try {
    Wait-ForPort $BackendPort  'Backend'  | Out-Null
    Wait-ForPort $FrontendPort 'Frontend' | Out-Null

    $url = "http://127.0.0.1:$FrontendPort/"
    Write-Host "`n  Ground station: $url" -ForegroundColor Cyan
    Write-Host "  API docs:       http://127.0.0.1:$BackendPort/docs`n"
    if (-not $NoBrowser) { Start-Process $url }

    Write-Host "Press Ctrl+C to stop both processes."
    while ($true) { Start-Sleep -Seconds 2 }
}
finally {
    Write-Host "`nStopping..." -ForegroundColor Yellow
    foreach ($p in @($frontend, $backend)) {
        if ($p -and -not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
    }
    # npm run dev spawns a child node process that outlives cmd.
    Get-NetTCPConnection -LocalPort $FrontendPort -State Listen -ErrorAction SilentlyContinue |
        ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
}
