# Re-save the two launcher files with the encodings that actually work on a Chinese Windows.
#
# Why this file exists at all:
#
#   * The .cmd launcher is read by cmd.exe using the ANSI codepage (936/GBK on a Chinese Windows).
#     UTF-8 Chinese inside a .cmd is therefore read as mojibake, and every line breaks. So the .cmd
#     must contain no non-ASCII byte at all. ASCII is a strict subset of GBK, so writing it as ASCII
#     is correct under either codepage.
#
#   * PowerShell 5.1 reads a .ps1 as ANSI unless the file starts with a UTF-8 BOM. The BOM is the
#     only thing that makes the Chinese text in launch.ps1 render correctly, so it must be written
#     *with* one.
#
# This script is pure ASCII on purpose: it has to run before launch.ps1 has its BOM, so it cannot
# rely on one itself, and it locates the launcher by pattern instead of by its Chinese filename.
#
# Run:  powershell -File tools\fix-encoding.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

# Locate by pattern: naming these files in Chinese here would need a BOM in *this* file, which is
# exactly what it does not have yet.
$cmdFile = (Get-ChildItem -LiteralPath $root -Filter '*.cmd' -File | Select-Object -First 1)
$ps1File = Join-Path $root 'launch.ps1'

if (-not $cmdFile) { throw "no .cmd launcher found in $root" }
if (-not (Test-Path $ps1File)) { throw "launch.ps1 not found in $root" }

# --- the .cmd : read as UTF-8, drop every non-ASCII character, write as ASCII ---
# CRLF, not whatever came in. cmd.exe parses batch files expecting CRLF; an LF-only .cmd mostly works
# by luck on a short script and then fails unreadably once there are `goto` labels or multi-line `if`
# blocks. Normalising here as well as in .gitattributes means a hand-edited bundle is safe too.
$cmdText = [IO.File]::ReadAllText($cmdFile.FullName, [Text.Encoding]::UTF8)
$stripped = ($cmdText.ToCharArray() | Where-Object { [int]$_ -lt 128 }) -join ''
$stripped = ($stripped -replace "`r`n", "`n") -replace "`n", "`r`n"
[IO.File]::WriteAllText($cmdFile.FullName, $stripped, [Text.Encoding]::ASCII)
$left = ([IO.File]::ReadAllBytes($cmdFile.FullName) | Where-Object { $_ -gt 127 }).Count
$crlf = ([regex]::Matches($stripped, "`r`n")).Count
Write-Host ("  [ok]   {0} -> ASCII, CRLF ({1} non-ascii bytes left, {2} lines)" -f $cmdFile.Name, $left, $crlf)

# --- launch.ps1 : read as UTF-8 regardless of BOM, write back with one ---
$ps1Text = [IO.File]::ReadAllText($ps1File, [Text.Encoding]::UTF8)
[IO.File]::WriteAllText($ps1File, $ps1Text, (New-Object Text.UTF8Encoding $true))
$bom = ([IO.File]::ReadAllBytes($ps1File)[0..2] | ForEach-Object { $_.ToString('X2') }) -join ' '
Write-Host ("  [ok]   launch.ps1 -> UTF-8 with BOM ({0})" -f $bom)

Write-Host ''
Write-Host '  Done. Verify:  start.cmd status'