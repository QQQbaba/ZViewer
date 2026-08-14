param(
    [string]$SourceDir = '../ZViewerCLI',
    [string]$OutputDir = 'ZViewerCLI'
)

$ErrorActionPreference = 'Stop'

$src = Resolve-Path $SourceDir -ErrorAction Stop
$dst = Join-Path $PSScriptRoot $OutputDir

New-Item -ItemType Directory -Force -Path $dst | Out-Null

Copy-Item "$src\go.mod" "$dst\go.mod" -Force
Copy-Item "$src\go.sum" "$dst\go.sum" -Force

$content = Get-Content "$src\main.go" -Raw
$fixed = $content -replace '(?m)^(\s*AllowCredentials:\s*)true,(\s*)$', '${1}false,$2'
Set-Content "$dst\main.go" -Value $fixed -NoNewline

Write-Host "Prepared CLI source at $dst"
