#requires -Version 5.1
<#
.SYNOPSIS
    One-key control for the local Laya decision server that this extension's
    "Local Laya" model source talks to.

.DESCRIPTION
    Wraps tools/laya-serve-local.py so nobody has to remember the venv path, the port or how to
    find a stray process. Windows-first because that is where the server used to be impossible to
    run at all (the old tools/laya-server.sh is POSIX + MLX, Apple-silicon only).

    Commands

      status   (default) what is running, which model is loaded, is the checkpoint complete
      start    start the server in the background and wait until it answers /health
      stop     stop it, whether or not the pid file survived
      restart  stop, then start
      test     one real decision round trip through the extension's own protocol
      logs     last lines of the server log
      fetch    download the checkpoint from ModelScope (first run only)

    Examples

      .\tools\laya-ctl.cmd status
      .\tools\laya-ctl.cmd start
      .\tools\laya-ctl.cmd start -Port 8743 -Threads 4
      .\tools\laya-ctl.cmd start -Lan            # all interfaces, bearer token required
      .\tools\laya-ctl.cmd test
      .\tools\laya-ctl.cmd stop

    The extension's "Local Laya" source defaults to http://127.0.0.1:8742/v1, so 8742 is the port
    to keep unless you change the extension setting too.
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('status', 'start', 'stop', 'restart', 'test', 'logs', 'fetch', 'help')]
    [string]$Command = 'status',

    [int]$Port = 8742,

    [ValidateSet('cpu', 'cuda', 'auto')]
    [string]$Device = 'cpu',

    # 0 = let torch decide. Measured on this machine (6 physical / 12 logical cores): torch's default
    # and an explicit physical-core cap give the *same* latency (5008 vs 5009 ms), and 4 threads is
    # 26% slower. So this is only for pinning a deliberately smaller number, not a speed-up.
    [int]$Threads = 0,

    [switch]$Lan,

    # Diagnostic: record every request payload -- the exact state and questions the extension sent --
    # into this directory. The decision log keeps a flattened summary instead, which is a different
    # schema, so tuning against a match log measures the wrong thing.
    [string]$DumpStates = '',

    # Inference pool size. 1 is the package's own setting and serves one session fastest. Raise it to 2
    # (with -Threads 6) when two tabs host at once: with one worker the second request waits for the
    # first to finish entirely, which measured 18.0 s and 8.9 s for a pair of four-group requests.
    [int]$Workers = 1,

    # Rewrite the per-unit state lists as short strings ('HTNK 45,70 74%'). Measured on 159 captured
    # requests: the state is 3597 tokens against a 797-token budget, so 78% of it is never read by any
    # question. This saves 34%, which is not enough on its own (still 3x over) but shifts ~50 points of
    # `visibleEnemies` and `army` back into view.
    [switch]$CompactUnits,

    # Opt-in, NOT the default. The full state is ~3500 tokens against a ~797-token per-question budget,
    # so 78% of it was never read and forceReadiness / combatAssessment / queues were cut in 100% of
    # requests; this flag is the fix for that.
    #
    # It was off by default because an earlier A/B was read as "the player preferred the full state":
    # skips 10.6% -> 14.7%, target_no_longer_visible 0 -> 6, construction waits 43% -> 69%. A later A/B
    # over 10 matches, split by the model's own token signature rather than by the clock, does not bear
    # that out. Two of the three reasons did not reproduce at all (target_no_longer_visible was 0 in
    # both arms; construction waits 36% vs 40%, inside noise at n=55/42), and two indicators point the
    # other way: the slim arm needed fewer overrides (9.5% vs 13.3% of question groups) and waited less
    # overall (53.2% vs 62.5%), with the largest gap exactly where the mechanism predicts -- production
    # groups, vehicles 70% vs 89% and infantry 68% vs 90% of waits. Latency, bucketed by question count
    # so the workload is matched, is 15-24% lower in every bucket.
    #
    # Measured mechanism, from the request captures of each arm (laya-state-report.py): the full arm
    # sits at 1022 tokens/question and hits Laya's 1024 cap on 100% of questions, with army / queues /
    # economy / forceReadiness / decisionReadiness cut in 100% of them. The slim arm sits at 666-712 and
    # hits the cap 0% of the time, with those fields cut in 1%. The model is being handed a state it
    # cannot finish reading on the full arm, which is the most likely reason it declines to commit to
    # production there.
    #
    # Outcome metrics remain unmeasured: the arms were not played for comparable time (149 vs 55
    # minutes), and wins/losses are too low-frequency to read from a handful of matches. So this stays
    # opt-in on the strength of the mechanism and the matched-workload latency, not a proven win rate.
    [switch]$SlimState,

    # Per-question option budget, overriding the checkpoint's head_max_len (256). See where it is
    # added to the argument list: 512 restores the instructions the default was cutting off.
    [int]$HeadMaxLen = 512,

    [string]$Token = '',

    [int]$TailLines = 40
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Root = Split-Path -Parent $PSScriptRoot
$VenvPython = Join-Path $Root '.laya-venv\Scripts\python.exe'
$ModelDir = Join-Path $Root 'models\laya-multilingual'
$PidFile = Join-Path $Root '.laya-server.pid'
$LogOut = Join-Path $Root '.laya-server.out.log'
$LogErr = Join-Path $Root '.laya-server.err.log'
$HealthUrl = "http://127.0.0.1:$Port/health"

function Write-Head($text) { Write-Host ''; Write-Host "== $text" -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "  [ok]   $text" -ForegroundColor Green }
function Write-Bad($text) { Write-Host "  [--]   $text" -ForegroundColor DarkGray }
function Write-Warn2($text) { Write-Host "  [!!]   $text" -ForegroundColor Yellow }

function Get-ListenerPid {
    # netstat, not Get-NetTCPConnection: the cmdlet needs a module that is absent on some images,
    # and this has to work on a bare Windows box.
    $lines = & netstat.exe -ano -p TCP 2>$null | Select-String -Pattern "LISTENING\s+(\d+)\s*$"
    foreach ($line in $lines) {
        $parts = ($line.ToString().Trim() -split '\s+')
        if ($parts.Length -ge 5 -and $parts[1] -match ":$Port$") { return [int]$parts[-1] }
    }
    return 0
}

function Get-Health {
    try {
        return Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 8 -ErrorAction Stop
    } catch {
        return $null
    }
}

function Test-Checkpoint {
    $needed = @('model.safetensors', 'rl_agent_config.json',
                'encoder\config.json', 'tokenizer\tokenizer.json', 'tokenizer\tokenizer_config.json')
    $missing = @()
    foreach ($rel in $needed) { if (-not (Test-Path (Join-Path $ModelDir $rel))) { $missing += $rel } }
    return $missing
}

function Show-Status {
    Write-Head "Local Laya server  (port $Port)"

    $pidFromFile = 0
    if (Test-Path $PidFile) {
        $raw = (Get-Content $PidFile -Raw).Trim()
        if ($raw -match '^\d+$') { $pidFromFile = [int]$raw }
    }
    $listening = Get-ListenerPid
    $health = Get-Health

    if ($listening -gt 0) {
        $managed = if ($pidFromFile -eq $listening) { 'tracked by .laya-server.pid' } else { 'not in the pid file' }
        Write-Ok "listening on 127.0.0.1:$Port (PID $listening, $managed)"
    } else {
        Write-Bad "not listening on port $Port"
    }

    if ($health) {
        $loaded = if ($health.loaded) { ($health.loaded -join ', ') } else { '(none reported)' }
        Write-Ok "health: $($health.status)   device=$($health.device)   loaded=$loaded"
    } elseif ($listening -gt 0) {
        Write-Warn2 'the port is open but /health did not answer yet (a cold load takes a while)'
    }

    $missing = @(Test-Checkpoint)
    if ($missing.Count -eq 0) {
        $sizeMb = [math]::Round((Get-ChildItem $ModelDir -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1)
        Write-Ok "checkpoint ready: $ModelDir ($sizeMb MB)"
    } else {
        Write-Warn2 "checkpoint incomplete, missing: $($missing -join ', ')"
        Write-Bad 'run:  tools\laya-ctl.cmd fetch'
    }

    # Which state encoding the running server was started with. Two configurations exist and they
    # produce visibly different behaviour (measured: full state 3133 ms and 10.6% wasted decisions vs
    # --slim-state 2134 ms and 14.7%), and a server started earlier keeps running after the script that
    # started it exits -- so "which arm am I on" is not obvious from the outside. Read it from the
    # listener's own command line instead of guessing.
    $listenerPid = Get-ListenerPid
    if ($listenerPid -gt 0) {
        $cmdline = (Get-CimInstance Win32_Process -Filter "ProcessId=$listenerPid" -ErrorAction SilentlyContinue).CommandLine
        if ($cmdline -match '--slim-state') { Write-Ok 'state mode: slim (--slim-state)' }
        elseif ($cmdline) { Write-Ok 'state mode: full (default)' }
        if ($cmdline -match '--head-max-len\s+(\d+)') {
            $head = $Matches[1]
            if ([int]$head -ge 512) { Write-Ok "option budget: $head tokens (instructions not truncated)" }
            else { Write-Bad "option budget: $head tokens -- the vehicle instructions are cut off here" }
        }
        else { Write-Bad 'option budget: checkpoint default (256) -- instructions are truncated' }
    }

    if (Test-Path $VenvPython) { Write-Ok "python: $VenvPython" }    else {
        Write-Warn2 "python not found: $VenvPython"
        Write-Bad 'install:  python -m venv .laya-venv'
        Write-Bad '          .laya-venv\Scripts\python -m pip install "laya[serve]"'
    }

    if ($listening -gt 0) {
        Write-Host ''
        Write-Host "  Extension setting: model source = Local Laya, local server URL = http://127.0.0.1:$Port/v1"
    }
}

function Start-Server {
    Write-Head "Starting the local Laya server on port $Port"

    if ((Get-ListenerPid) -gt 0) { Write-Warn2 "already listening on $Port; nothing to do"; Show-Status; return }
    if (-not (Test-Path $VenvPython)) { throw "Python environment missing: $VenvPython`nRun:  python -m venv .laya-venv  then  .laya-venv\Scripts\python -m pip install ""laya[serve]""" }
    $missing = @(Test-Checkpoint)
    if ($missing.Count -gt 0) { throw "Checkpoint incomplete ($($missing -join ', ')). Run:  python tools/laya-model-fetch.py" }

    $script = Join-Path $Root 'tools\laya-serve-local.py'
    $argList = @($script, '--port', "$Port", '--device', $Device)
    if ($Threads -gt 0) { $argList += @('--threads', "$Threads") }
    if ($Lan) { $argList += '--lan' }
    if ($DumpStates) { $argList += @('--dump-states', $DumpStates) }
    if ($Workers -ne 1) { $argList += @('--workers', "$Workers") }
    if ($CompactUnits) { $argList += '--compact-units' }
    if ($SlimState) { $argList += '--slim-state' }
    # The per-question option budget. `build_sequence` caps every option at 48 tokens and gives the
    # instructions whatever is left, so with 3 options the default 256 leaves the instructions 109
    # tokens -- and the vehicle instructions are 273. The sentence that actually decides the question
    # ("ECONOMY FIRST: ... Produce the offered miner now") sits at the end and was being cut off:
    # measured on 20 real captured vehicle questions against laya-multilingual, the model answered
    # wait 18 of 20 at 256 and 4 of 20 at 512. The cost is latency (1052 -> 1431 ms per question),
    # not model load -- the head is a small part of the sequence.
    if ($HeadMaxLen -gt 0) { $argList += @('--head-max-len', "$HeadMaxLen") }
    if ($Token) { $argList += @('--token', $Token) }

    $proc = Start-Process -FilePath $VenvPython -ArgumentList $argList -WorkingDirectory $Root `
        -WindowStyle Hidden -PassThru -RedirectStandardOutput $LogOut -RedirectStandardError $LogErr
    Set-Content -Path $PidFile -Value $proc.Id -Encoding ascii
    Write-Bad "launched PID $($proc.Id); waiting for the model to load (first run can take a minute)"

    # A cold load reads a 614 MB checkpoint before uvicorn binds the port, so poll rather than sleep.
    $deadline = (Get-Date).AddSeconds(300)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 750
        if ($proc.HasExited) {
            Write-Host ''
            Write-Warn2 "the server exited with code $($proc.ExitCode); last log lines:"
            if (Test-Path $LogErr) { Get-Content $LogErr -Tail 20 | ForEach-Object { "    $_" } }
            if (Test-Path $LogOut) { Get-Content $LogOut -Tail 20 | ForEach-Object { "    $_" } }
            Remove-Item $PidFile -ErrorAction SilentlyContinue
            throw 'The local Laya server failed to start.'
        }
        if (Get-Health) {
            # python.exe inside a venv is a shim that starts the real interpreter as a child, so the
            # PID Start-Process returned is already gone by now. Record whoever owns the port.
            $actual = Get-ListenerPid
            if ($actual -gt 0) { Set-Content -Path $PidFile -Value $actual -Encoding ascii }
            Write-Ok "ready after $([int]((Get-Date) - $proc.StartTime).TotalSeconds)s"
            Show-Status
            return
        }
    }
    Write-Warn2 'still loading after 300s; check logs with:  laya-ctl logs'
    Show-Status
}

function Stop-Server {
    Write-Head "Stopping the local Laya server on port $Port"

    $targets = @()
    if (Test-Path $PidFile) {
        $raw = (Get-Content $PidFile -Raw).Trim()
        if ($raw -match '^\d+$') { $targets += [int]$raw }
    }
    $listener = Get-ListenerPid
    if ($listener -gt 0 -and $targets -notcontains $listener) { $targets += $listener }

    if ($targets.Count -eq 0) { Write-Bad 'nothing to stop'; Remove-Item $PidFile -ErrorAction SilentlyContinue; return }

    foreach ($procId in $targets) {
        try {
            Stop-Process -Id $procId -ErrorAction Stop
            Write-Ok "stopped PID $procId"
        } catch {
            Write-Warn2 "could not stop PID ${procId}: $($_.Exception.Message)"
        }
    }
    for ($i = 0; $i -lt 20 -and (Get-ListenerPid) -gt 0; $i++) { Start-Sleep -Milliseconds 500 }
    if ((Get-ListenerPid) -gt 0) { Write-Warn2 "port $Port is still open" } else { Write-Ok "port $Port released" }
    Remove-Item $PidFile -ErrorAction SilentlyContinue
}

function Invoke-Check {
    if (-not (Test-Path $VenvPython)) { throw "Python environment missing: $VenvPython" }
    Write-Head 'Decision round trip through the extension protocol'
    # Built as an array and splatted: an inline $(if ...) subexpression would be passed to the
    # native command as one argument.
    $checkArgs = @((Join-Path $Root 'tools\laya-check.py'), '--url', "http://127.0.0.1:$Port/v1")
    if ($Token) { $checkArgs += @('--token', $Token) }
    & $VenvPython @checkArgs
    if ($LASTEXITCODE -ne 0) { Write-Warn2 "check failed with exit code $LASTEXITCODE" } else { Write-Ok 'the extension will accept these answers' }
}

function Show-Logs {
    foreach ($file in @($LogOut, $LogErr)) {
        Write-Head (Split-Path -Leaf $file)
        if (Test-Path $file) { Get-Content $file -Tail $TailLines } else { Write-Bad 'no such log yet' }
    }
}

function Invoke-Fetch {
    if (-not (Test-Path $VenvPython)) { throw "Python environment missing: $VenvPython" }
    & $VenvPython (Join-Path $Root 'tools\laya-model-fetch.py')
    if ($LASTEXITCODE -ne 0) { throw "checkpoint download failed (exit $LASTEXITCODE)" }
}

switch ($Command) {
    'status' { Show-Status }
    'start' { Start-Server }
    'stop' { Stop-Server }
    'restart' { Stop-Server; Start-Server }
    'test' { Invoke-Check }
    'logs' { Show-Logs }
    'fetch' { Invoke-Fetch }
    'help' { Get-Help $PSCommandPath -Detailed }
}
