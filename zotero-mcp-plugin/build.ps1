# Build the MCP Zotero API plugin XPI (Windows / PowerShell, no `zip` needed)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$PluginName = "mcp-zotero-api"

# Read version from manifest.json (single source of truth)
$Version = (Get-Content manifest.json -Raw | ConvertFrom-Json).version

$Xpi = "$PluginName.xpi"
Remove-Item -Force $Xpi -ErrorAction SilentlyContinue

# XPI is just a ZIP with the files at the archive root
Compress-Archive -Path manifest.json, bootstrap.js, icon.svg, vendor -DestinationPath $Xpi -Force

Write-Output "Built $Xpi (v$Version)"
Write-Output ""
Write-Output "To install:"
Write-Output "  1. Open Zotero"
Write-Output "  2. Tools -> Add-ons"
Write-Output "  3. Gear icon -> Install Add-on From File..."
Write-Output "  4. Select $Xpi"
Write-Output "  5. Restart Zotero"
Write-Output ""
Write-Output "To release: create GitHub Release tag v$Version, attach $Xpi,"
Write-Output "and make sure updates.json lists v$Version."
