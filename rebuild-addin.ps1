# rebuild-addin.ps1 - rebuild the StudIQ Excel COM add-in and prompt to reload
# Usage: powershell -ExecutionPolicy Bypass -File rebuild-addin.ps1

$root    = Split-Path -Parent $MyInvocation.MyCommand.Path
$project = Join-Path $root "excel-com-addin"
$xll     = Join-Path $project "bin\Release\net48\StudIQ64.xll"

$excel = Get-Process -Name EXCEL -ErrorAction SilentlyContinue
if ($excel) {
    Write-Host "Closing Excel..." -ForegroundColor Yellow
    $excel | Stop-Process -Force
    Start-Sleep -Seconds 2
} else {
    Write-Host "Excel not running." -ForegroundColor Gray
}

Write-Host "Building COM add-in..." -ForegroundColor Cyan
dotnet build $project -c Release
if ($LASTEXITCODE -ne 0) {
    Write-Host "Build FAILED." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Done. Open Excel - add-in loads automatically if already registered." -ForegroundColor Green
Write-Host ""
Write-Host "First time setup:" -ForegroundColor Yellow
Write-Host "  File > Options > Add-ins > Manage: Excel Add-ins > Go > Browse" -ForegroundColor Yellow
Write-Host "  File: $xll" -ForegroundColor Yellow
