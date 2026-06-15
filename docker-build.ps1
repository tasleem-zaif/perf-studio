# ─────────────────────────────────────────────────────────────────────────────
# PerfStudio Docker Build Script (Windows PowerShell)
#
# Usage:
#   .\docker-build.ps1              # Build with default tag perfstudio:latest
#   .\docker-build.ps1 -Tag 1.2.0   # Build with custom tag
#   .\docker-build.ps1 -Push        # Build and push to Docker Hub
# ─────────────────────────────────────────────────────────────────────────────

param(
    [string]$Tag = "latest",
    [string]$Registry = "tasleemzaif",
    [switch]$Push = $false,
    [switch]$NoCache = $false
)

$ImageName = "$Registry/perfstudio:$Tag"
$LatestTag = "$Registry/perfstudio:latest"

Write-Host "Building PerfStudio all-in-one image..." -ForegroundColor Cyan
Write-Host "  Image : $ImageName" -ForegroundColor Gray
Write-Host "  No-cache: $NoCache" -ForegroundColor Gray
Write-Host ""

$buildArgs = @("build", "-t", $ImageName, "-t", $LatestTag)
if ($NoCache) { $buildArgs += "--no-cache" }
$buildArgs += "."

& docker $buildArgs

if ($LASTEXITCODE -ne 0) {
    Write-Host "Build FAILED" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Build successful!" -ForegroundColor Green
Write-Host ""
Write-Host "To run:"
Write-Host "  docker run -d -p 3001:3001 -v perfstudio_data:/app/data $ImageName"
Write-Host ""
Write-Host "Or with docker compose:"
Write-Host "  docker compose up -d"
Write-Host ""

if ($Push) {
    Write-Host "Pushing to Docker Hub..." -ForegroundColor Cyan
    docker push $ImageName
    docker push $LatestTag
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Pushed successfully!" -ForegroundColor Green
    } else {
        Write-Host "Push FAILED" -ForegroundColor Red
        exit 1
    }
}
