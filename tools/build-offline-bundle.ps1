#requires -Version 5.1
<#
.SYNOPSIS
    Assemble the offline bundle: a self-contained directory holding the built extension, the local
    Laya checkpoint, a CUDA-enabled Python environment and a one-double-click launcher.

.DESCRIPTION
    The bundle is what you hand to someone who should get a working local model without installing
    Python, without a Jev key and without network access. This script is the recipe that produced it,
    kept in the repository so it can be rebuilt instead of re-derived.

    It is NOT the same as `npm run laya`. That one drives `laya_mlx`, which is Apple-silicon only;
    see docs/local-laya.md. This one uses the PyPI `laya` package -- plain PyTorch, CPU or CUDA,
    every platform -- whose `laya-serve` already speaks the exact /v1/systemone protocol the
    extension uses, so the extension needs no changes.

    Requires network: roughly 5.5 GB, almost all of it the CUDA PyTorch wheel (cu124 is ~2.4 GB on
    Windows) plus the 647 MB checkpoint. The *result* needs no network.

    The generated package must stay at the path it was built to. A venv records the absolute path
    of its interpreter, so copying the directory elsewhere invalidates venv\Scripts\python.exe;
    model/ and tools/ move freely. The bundled manual (section 6.1) explains the rebuild for a
    new location.

.EXAMPLE
    .\tools\build-offline-bundle.ps1 -Destination D:\jev-offline
    ...then double-click the launcher it puts in D:\jev-offline

.EXAMPLE
    # CPU-only build, ~1 GB smaller, roughly an order of magnitude slower per decision.
    .\tools\build-offline-bundle.ps1 -Destination D:\jev-offline-cpu -Device cpu

.NOTES
    Pure ASCII in this file on purpose. It locates the launcher by pattern rather than by its
    Chinese filename, because a script holding a Chinese string needs a UTF-8 BOM to read it
    correctly, and the BOM it would install into the launchers has to come from here first.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Destination,

    # The extension's own port. Keep in sync with what the launcher tells the user to type.
    [int]$Port = 8742,

    [ValidateSet('cuda', 'cpu')]
    [string]$Device = 'cuda',

    [string]$PythonExe = 'python',
    [switch]$SkipModel,
    [switch]$SkipExtension
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root 'tools\offline-bundle'
$dst = $Destination

function Step($text) { Write-Host ''; Write-Host "== $text" -ForegroundColor Cyan }
function Ok($text)   { Write-Host "  [ok]   $text" -ForegroundColor Green }
function Warn2($text){ Write-Host "  [!!]   $text" -ForegroundColor Yellow }
function Die($text)  { Write-Host "  [!!]   $text" -ForegroundColor Red; exit 1 }

if (-not (Test-Path $src)) { Die "missing $src" }

Step "Destination: $dst"
if (Test-Path $dst) {
    if (-not (Get-ChildItem $dst -Force | Select-Object -First 1)) { Ok 'exists and is empty' }
    else {
        Warn2 'exists and is not empty'
        $answer = Read-Host '  overwrite it? Type YES to continue'
        if ($answer -ne 'YES') { Die 'stopped' }
        Remove-Item $dst -Recurse -Force
    }
} else { New-Item -ItemType Directory -Force -Path $dst | Out-Null; Ok 'created' }

foreach ($d in @('tools', 'extension')) { New-Item -ItemType Directory -Force -Path (Join-Path $dst $d) | Out-Null }

# ---------------------------------------------------------------- extension
if ($SkipExtension) {
    Warn2 'skipping the extension build (--SkipExtension)'
} else {
    Step 'Building the extension'
    Push-Location $root
    try {
        & npm run package
        if ($LASTEXITCODE -ne 0) { Die 'npm run package failed' }
    } finally { Pop-Location }
    $dist = Join-Path $root 'dist'
    if (-not (Test-Path $dist)) { Die "no dist/ after the build" }
    # Enumerate rather than `Copy-Item <dir>\*`: the glob form silently copies nothing under some
    # invocation contexts, and the only symptom is a bundle that still holds the previous build.
    Copy-Item (Get-ChildItem $dist -Recurse -File).FullName (Join-Path $dst 'extension') -Force
    # Prove the copy landed. A bundle whose extension is an older build is worse than no bundle: it
    # loads, it connects, and every fix made since is silently absent -- and the only way to notice is
    # to look at the build stamp. Compare the two BUILD files rather than trusting the copy.
    $built = Join-Path $dist 'BUILD.json'
    $copied = Join-Path $dst 'extension\BUILD.json'
    if (Test-Path $built) {
        $want = (Get-Content $built -Raw | ConvertFrom-Json).build
        $got = if (Test-Path $copied) { (Get-Content $copied -Raw | ConvertFrom-Json).build } else { 'MISSING' }
        if ($want -ne $got) { Die "extension copy is stale: built $want, bundle has $got. Refusing to hand over a bundle that loads the old build." }
        Ok "extension build verified: $got"
    }
    Ok "extension -> extension\  ($([math]::Round((Get-ChildItem (Join-Path $dst 'extension') -Recurse -File | Measure-Object Length -Sum).Sum / 1KB)) KB)"
}

# ---------------------------------------------------------------- venv
$venv = Join-Path $dst 'venv'
$vpy = Join-Path $venv 'Scripts\python.exe'

Step 'Python environment'
if (Test-Path $vpy) {
    Warn2 'venv already present, reusing it'
} else {
    Ok "creating $venv"
    & $PythonExe -m venv $venv
    if ($LASTEXITCODE -ne 0) { Die "venv creation failed (is '$PythonExe' a Python 3.10+ interpreter?)" }
    & $vpy -m pip install --quiet --upgrade pip
}

Step 'Installing torch and laya'
if ($Device -eq 'cuda') {
    # cu124 is the smallest CUDA build with a cp313 wheel, and covers Ampere (RTX 30-series) fully.
    # Newer cu128 wheels are larger, not faster here: this model is 647 MB and never leaves the GPU.
    Warn2 'the CUDA PyTorch wheel is ~2.4 GB on Windows; this takes a while'
    & $vpy -m pip install 'torch' --index-url https://download.pytorch.org/whl/cu124 --timeout 120 --retries 5
} else {
    Ok 'CPU build (about 1 GB smaller, roughly an order of magnitude slower per decision)'
    & $vpy -m pip install 'torch' --index-url https://download.pytorch.org/whl/cpu --timeout 120 --retries 5
}
if ($LASTEXITCODE -ne 0) { Die 'torch install failed' }

& $vpy -m pip install 'laya[serve]'
if ($LASTEXITCODE -ne 0) { Die 'laya[serve] install failed' }
Ok "torch + laya installed"

# ---------------------------------------------------------------- checkpoint
$modelDir = Join-Path $dst 'model\laya-multilingual'
if ($SkipModel) {
    Warn2 'skipping the checkpoint download (--SkipModel)'
} elseif (Test-Path (Join-Path $modelDir 'model.safetensors')) {
    Ok 'checkpoint already present'
} else {
    Step 'Downloading the checkpoint from ModelScope (647 MB)'
    & $vpy (Join-Path $dst 'tools\laya-model-fetch.py') --dir $modelDir
    if ($LASTEXITCODE -ne 0) { Die 'checkpoint download failed' }
    Ok ("checkpoint ready ({0} MB)" -f [math]::Round((Get-ChildItem $modelDir -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1))
}

# ---------------------------------------------------------------- scripts
Step 'Copying the runtime scripts'
foreach ($n in @('laya-serve-local.py', 'laya-model-fetch.py', 'laya-ctl.ps1', 'laya-ctl.cmd', 'laya-check.py', 'laya-state-report.py')) {
    $from = Join-Path $root "tools\$n"
    if (-not (Test-Path $from)) { Die "missing repo file tools\$n" }
    Copy-Item $from (Join-Path $dst 'tools') -Force
}
Copy-Item (Join-Path $src 'fix-encoding.ps1') (Join-Path $dst 'tools') -Force
Get-ChildItem (Join-Path $dst 'tools') -File | ForEach-Object { Ok "tools\$($_.Name)" }

# The launcher, its dispatch stub and the manual, by pattern so this script stays ASCII.
$launcher = Get-ChildItem $src -Filter '*.ps1' | Where-Object { $_.Name -ne 'fix-encoding.ps1' } | Select-Object -First 1
$stub = Get-ChildItem $src -Filter '*.cmd' | Select-Object -First 1
$manual = Get-ChildItem $src -Filter '*.md' | Select-Object -First 1
Copy-Item $launcher.FullName $dst -Force
Copy-Item $stub.FullName $dst -Force
Copy-Item $manual.FullName $dst -Force

# ---------------------------------------------------------------- encodings
# A .cmd is parsed with the ANSI codepage (936 on a Chinese Windows), so UTF-8 Chinese in it is
# read as mojibake and the file stops working. The stub has to be ASCII; the Chinese lives in the
# .ps1, which only renders right with a UTF-8 BOM. Shipping them without that step produces a
# bundle whose launcher prints garbage, so it is part of the build, not an afterthought.
Step 'Fixing file encodings'
& (Join-Path $dst 'tools\fix-encoding.ps1')

# ---------------------------------------------------------------- verify
Step 'Verifying'
& $vpy -c "import torch, laya; print('  torch', torch.__version__, '| cuda', torch.cuda.is_available())"
$stubName = $stub.Name
Write-Host "  -> $dst\$stubName"
Write-Host ''
Write-Host '  Done. Now double-click it, or run:' -ForegroundColor Green
Write-Host ("    {0}\tools\laya-ctl.cmd status -Python {1}\venv\Scripts\python.exe -Model {1}\model\laya-multilingual" -f $dst, $dst)
Write-Host ''