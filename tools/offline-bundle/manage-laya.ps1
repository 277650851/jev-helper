#requires -Version 5.1
<#
    Laya 本地决策服务管理器（交互式菜单）

    用法:
        .\manage-laya.ps1                       # 或在资源管理器里双击 manage-laya.cmd
        .\manage-laya.ps1 -Command status       # 不走菜单，直接执行一条（可被别的脚本调用）
        .\manage-laya.ps1 -Port 8743            # 换端口（记得扩展里同步改）

    说明:
        启动/停止/状态/自检/日志这些实际操作，全部转交给 tools\laya-ctl.ps1 执行。
        本脚本只负责菜单和显示。这样端口、PID 文件、健康检查、权重校验只有一份实现，
        不会出现"菜单里能停、命令行停不掉"这类漂移。

    目录布局（与旧版不同，旧的假设 .ps1 与 tools/、.laya-venv/、models/ 同目录）:
        源码仓库  <Repo>    —— tools\ 与 dist\ 在这里，默认 C:\laya\jev-helper
        离线整合包 <Bundle> —— venv\ 与 model\ 在这里，默认 C:\laya\jev-helper-offline
        两者都自动探测，可用 -Repo / -Bundle 覆盖。

    注意:
        本文件必须保存为「UTF-8 with BOM」。Windows PowerShell 5.1 会按系统 ANSI
        （中文系统上是 GBK）解码没有 BOM 的 .ps1，中文会变成乱码并把引号吃掉，
        脚本直接报语法错误。
#>
[CmdletBinding()]
param(
    # 服务端口。扩展默认连 8742。
    [int]$Port = 8742,

    # 源码仓库；留空则自动探测
    [string]$Repo = '',

    # 离线整合包（venv 与 model）；留空则自动探测
    [string]$Bundle = '',

    # 请求采集目录；留空则用 <Repo>\.laya-states
    [string]$DumpDir = '',

    # 推理设备。必须是个真参数：Invoke-Ctl 会把它交给 laya-ctl.ps1，
    # 而 laya-ctl.ps1 自己的默认值是 cpu —— 不传就一直在 CPU 上跑。
    [ValidateSet('cpu', 'cuda', 'auto')]
    [string]$Device = 'cuda',

    # 给了就直接执行这一条命令然后退出，不走菜单
    [string]$Command = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# 让子进程（python 的字段统计、node 的分析工具）输出的中文能正确显示。
# Windows PowerShell 5.1 默认按控制台代码页（中文系统是 GBK）解码子进程的 stdout，
# 而这两个工具都输出 UTF-8，于是中文全成乱码。$OutputEncoding 只管发给子进程的输入，
# 真正管解码的是 [Console]::OutputEncoding；PYTHONIOENCODING 让 python 端也按 UTF-8 写。
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
try { $OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$env:PYTHONIOENCODING = 'utf-8'

# ---------------------------------------------------------------- 目录探测
# 自适应探测，而不是信任硬编码路径：本菜单可能躺在离线整合包里（venv\、model\、extension\），而源码仓库
# 在别处（tools\、src\、dist\）。先看自己周围，再退回已知位置，并且**每一步都验证**——旧版把
# 'C:\laya\jev-helper' 当兜底却从不检查，路径不存在时静默沿用，于是"缺 dist\BUILD.json"报的是一个根本
# 没在看的仓库（实测：真正的构建在 C:\laya0.7.5\dist）。
$Here = $PSScriptRoot
$near = @(
    $Here,
    (Split-Path -Parent $Here),
    (Join-Path (Split-Path -Parent $Here) 'jev-helper'),
    'C:\laya\jev-helper',
    'C:\laya0.7.5',
    'C:\laya'
)
if (-not $Repo) {
    foreach ($c in $near) {
        if (-not $c -or -not (Test-Path $c)) { continue }
        $hit = if (Test-Path (Join-Path $c 'tools\laya-ctl.ps1')) { $c } else {
            Get-ChildItem $c -Directory -ErrorAction SilentlyContinue |
                Where-Object { Test-Path (Join-Path $_.FullName 'tools\laya-ctl.ps1') } |
                Select-Object -First 1 -ExpandProperty FullName
        }
        if ($hit) { $Repo = (Resolve-Path $hit).Path; break }
    }
}
if (-not $Repo) {
    Write-Host '  [警告] 找不到源码仓库（该目录下应有 tools\laya-ctl.ps1）。' -ForegroundColor Yellow
    Write-Host '         用 -Repo <路径> 指定；只依赖源码仓库的选项会不准确。' -ForegroundColor Yellow
    $Repo = Split-Path -Parent $Here
}

$Bundles = @(
    (Join-Path (Split-Path -Parent $Repo) 'jev-helper-offline'),
    $Here,
    (Split-Path -Parent $Here),
    'C:\laya\jev-helper-offline'
)
if (-not $Bundle) {
    foreach ($b in $Bundles) { if ($b -and (Test-Path (Join-Path $b 'venv\Scripts\python.exe'))) { $Bundle = (Resolve-Path $b).Path; break } }
}
if (-not $Bundle) { $Bundle = (Split-Path -Parent $Repo) }

# 优先用离线包里那份 laya-ctl.ps1。两份文件字节完全相同（同一 SHA-256），区别只在于
# 它把运行时状态放在自己旁边：PID 文件、日志、服务状态都跟着 $Root 走。
#   用离线包那份 -> 日志在 C:\laya\jev-helper-offline\.laya-server.*（你平时看的位置，也是
#                    双击启动.cmd 时用的位置）
#   用仓库那份   -> 日志跑到 C:\laya\jev-helper\ 去，两个位置各有一套 pid 文件，
#                    于是「用菜单停不掉命令行起的服务」这类漂移就出现了。
# 关键是**启动和停止必须用同一份**，所以这里固定选一个。
$Ctl = Join-Path $Bundle 'tools\laya-ctl.ps1'
if (-not (Test-Path $Ctl)) { $Ctl = Join-Path $Repo 'tools\laya-ctl.ps1' }
$VenvPython = Join-Path $Bundle 'venv\Scripts\python.exe'
$ModelDir   = Join-Path $Bundle 'model\laya-multilingual'
$HealthUrl  = "http://127.0.0.1:$Port/health"
if (-not $DumpDir) { $DumpDir = Join-Path $Repo '.laya-states' }
$ReportsDir = Join-Path $env:USERPROFILE 'Downloads\jev-reports'
# 构建成品的位置随布局而变：源码仓库里是 dist\，而 tools/build-offline-bundle.ps1 打进整合包的是
# extension\。只看 dist\ 会对一个明明带着构建的整合包报"缺 BUILD.json"。
$BuildDir = @((Join-Path $Repo 'dist'), (Join-Path $Repo 'extension'), (Join-Path $Bundle 'extension')) |
    Where-Object { $_ -and (Test-Path (Join-Path $_ 'BUILD.json')) } | Select-Object -First 1
if (-not $BuildDir) { $BuildDir = Join-Path $Repo 'dist' }
$DistBuild  = Join-Path $BuildDir 'BUILD.json'

# Get-NetTCPConnection 需要 NetTCPIP 模块，个别精简系统上没有；netstat 哪都有。
$HasNetTcp = $null -ne (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue)

function Write-Banner {
    param([string]$Title)
    Write-Host ''
    Write-Host '========================================' -ForegroundColor Cyan
    Write-Host "  $Title" -ForegroundColor Cyan
    Write-Host '========================================' -ForegroundColor Cyan
    Write-Host ''
}

function Clear-Screen {
    try { Clear-Host } catch { }
}

function Get-PortListener {
    # 返回 @{ Pid = <int>; Name = <string> }，没有监听则返回 $null。
    if ($HasNetTcp) {
        $l = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($l) {
            $p = Get-Process -Id $l.OwningProcess -ErrorAction SilentlyContinue
            return @{ Pid = [int]$l.OwningProcess; Name = if ($p) { $p.ProcessName } else { '?' } }
        }
        return $null
    }
    $line = netstat.exe -ano -p TCP 2>$null | Select-String -Pattern "LISTENING\s+(\d+)\s*$" |
        Where-Object { ($_.ToString().Trim() -split '\s+')[1] -match ":$Port$" } | Select-Object -First 1
    if (-not $line) { return $null }
    $id = [int](($line.ToString().Trim() -split '\s+')[-1])
    $p = Get-Process -Id $id -ErrorAction SilentlyContinue
    return @{ Pid = $id; Name = if ($p) { $p.ProcessName } else { '?' } }
}

function Test-PortInUse { $null -ne (Get-PortListener) }

function Get-Health {
    try { return Invoke-RestMethod $HealthUrl -TimeoutSec 5 -ErrorAction Stop } catch { return $null }
}

function Show-Paths {
    Write-Host '  源码仓库: ' -NoNewline
    if (Test-Path $Repo) { Write-Host $Repo -ForegroundColor Green } else { Write-Host "$Repo  [找不到]" -ForegroundColor Red }
    Write-Host '  离线整合包: ' -NoNewline
    if (Test-Path $VenvPython) { Write-Host $Bundle -ForegroundColor Green } else { Write-Host "$Bundle  [找不到 venv]" -ForegroundColor Red }
}

function Show-ServiceInfo {
    Write-Host '----------------------------------------' -ForegroundColor DarkGray
    Write-Host '  服务信息' -ForegroundColor Cyan
    Write-Host '----------------------------------------' -ForegroundColor DarkGray

    $listener = Get-PortListener
    $health = Get-Health

    Write-Host '  运行状态: ' -NoNewline
    if ($listener) { Write-Host "运行中（PID $($listener.Pid) · $($listener.Name)）" -ForegroundColor Green }
    else { Write-Host '已停止' -ForegroundColor Red }

    if ($health) {
        $loaded = if ($health.loaded) { $health.loaded -join ', ' } else { '（未报告）' }
        Write-Host "  已加载模型: $loaded" -ForegroundColor Green
        Write-Host "  推理设备:   $($health.device)"
    } elseif ($listener) {
        Write-Host '  健康检查:   端口已开但 /health 还没应答（冷启动加载权重要一会儿）' -ForegroundColor Yellow
    }

    Write-Host '  接口地址: ' -NoNewline
    Write-Host "http://127.0.0.1:$Port/v1/systemone"
    Write-Host '  健康检查: ' -NoNewline
    Write-Host "http://127.0.0.1:$Port/health"

    Write-Host '  运行环境: ' -NoNewline
    if (Test-Path $VenvPython) { Write-Host 'venv 就绪' -ForegroundColor Green }
    else { Write-Host "缺少 $VenvPython" -ForegroundColor Yellow }

    Write-Host '  模型权重: ' -NoNewline
    if (Test-Path (Join-Path $ModelDir 'model.safetensors')) { Write-Host '完整' -ForegroundColor Green }
    else { Write-Host "缺失（$ModelDir）" -ForegroundColor Red }

    Write-Host '  扩展构建: ' -NoNewline
    if (Test-Path $DistBuild) {
        $b = Get-Content $DistBuild -Raw | ConvertFrom-Json
        Write-Host "$($b.build)   $($b.builtAt)" -ForegroundColor Green
        Write-Host '             改了 src/ 之后：npm test（内含 build）→ chrome://extensions 重新加载 dist/ → 刷新游戏页' -ForegroundColor DarkGray
    } else { Write-Host "缺 BUILD.json：$BuildDir 里没有构建成品（源码仓库：跑 npm test；整合包：重跑 tools\build-offline-bundle.ps1）" -ForegroundColor Yellow }

    Write-Host '  请求采集: ' -NoNewline
    $n = 0
    if (Test-Path $DumpDir) { $n = @(Get-ChildItem $DumpDir -Filter 'state-*.json' -ErrorAction SilentlyContinue).Count }
    if ($n) { Write-Host "$DumpDir（$n 份）" -ForegroundColor Green } else { Write-Host "$DumpDir（暂无）" -ForegroundColor DarkGray }

    Write-Host '----------------------------------------' -ForegroundColor DarkGray
    Write-Host ''
    Write-Host '  扩展里这样填：模型来源 = 本地 Laya，地址 = ' -NoNewline
    Write-Host "http://127.0.0.1:$Port/v1" -ForegroundColor White
    Write-Host '  本地模型名保持 laya-multilingual；本机模式访问令牌留空。' -ForegroundColor DarkGray
    Write-Host ''
}

# 所有实际操作都走 laya-ctl.ps1。三点必须注意：
#   1. 绝不加管道。服务是启动器的常驻子进程，管道要等它退出才关闭，会把这里挂死。
#   2. 不返回布尔值。返回值会漏进输出流，屏幕上就会多出莫名其妙的 True。
#      成功与否一律用「端口是否真的在监听」判断：laya-ctl 用 throw 报错，
#      而 $LASTEXITCODE 会被它内部 netstat 之类的命令污染，不可靠。
#   3. 额外参数用**哈希表**传递，不要用字符串数组。
#      数组 splat（@('-Workers','2')）在 Windows PowerShell 5.1 里会把数组元素当成
#      **位置参数的值**而不是参数名，于是报 "A positional parameter cannot be found that
#      accepts argument '-Workers'"，菜单 [8]/[9] 直接失效；同一个写法在 pwsh 7 下却能跑，
#      所以只在 5.1 里才暴露。哈希表 splat 两边都正确。
#   4. -Python / -Model 必须显式传：laya-ctl.ps1 默认找的是「和 tools/ 同级」的
#      .laya-venv 与 models\，而本机的 venv 和模型在离线整合包里，不传就报
#      "Python environment missing"。
function Invoke-Ctl {
    param(
        [Parameter(Mandatory)][string]$Command,
        [hashtable]$Extra = @{}
    )
    if (-not (Test-Path $Ctl)) {
        Write-Host "[X] 找不到 $Ctl（源码仓库路径不对？用 -Repo 指定）" -ForegroundColor Red
        Write-Host ''
        return
    }
    # Device MUST be in here. laya-ctl.ps1 defaults it to 'cpu' (its own parameter default), so leaving it
    # out silently ran the model on the CPU: the same request that takes ~2-3 s on the 3060 measured
    # 10225 ms in the extension's connection test, against an 18 s local timeout. The manager's -Device
    # parameter was parsed and then dropped.
    $bound = @{ Command = $Command; Port = $Port; Python = $VenvPython; Model = $ModelDir; Device = $Device }
    foreach ($key in $Extra.Keys) { $bound[$key] = $Extra[$key] }
    try { & $Ctl @bound }
    catch { Write-Host "[X] $($_.Exception.Message)" -ForegroundColor Red; Write-Host '' }
}

function Show-Started {
    if (Test-PortInUse) { Show-ServiceInfo }
    else {
        Write-Host '[X] 服务没有起来。用菜单 [6] 看日志排查。' -ForegroundColor Red
        Write-Host ''
    }
}

function Start-LayaService {
    Write-Banner '正在启动 Laya 本地决策服务'
    if (Test-PortInUse) {
        $listener = Get-PortListener
        Write-Host "[!] 端口 $Port 已被占用（PID $($listener.Pid) · $($listener.Name)）" -ForegroundColor Yellow
        Write-Host '    服务可能已经在运行。' -ForegroundColor Yellow
        Write-Host ''
        Show-ServiceInfo
        return
    }
    Write-Host '[*] 正在启动（首次加载权重要 6-20 秒）...' -ForegroundColor Green
    Write-Host ''
    Write-Host '  默认带 --slim-state：实测本机 state 3501-3597 token，而每题只剩约 797，78% 从未被读过；' -ForegroundColor DarkGray
    Write-Host '  forceReadiness / combatAssessment / queues / economy 有 95-100% 落在截断点之外。' -ForegroundColor DarkGray
    Write-Host '  slim 后 state 489 token、序列 715（低于 1024 上限），队列与 readiness 第一次可见。' -ForegroundColor DarkGray
    Write-Host '  代价：约 37.5% 的题组会改选不同选项——所以 [8] 保留全量 state 作为对照。' -ForegroundColor DarkGray
    Write-Host ''
    Invoke-Ctl -Command 'start' -Extra @{ SlimState = $true; DumpStates = $DumpDir }
    Show-Started
}

function Stop-LayaService {
    Write-Banner '正在停止 Laya 本地决策服务'
    if (-not (Test-PortInUse)) {
        Write-Host "[!] 端口 $Port 未被占用，服务未运行。" -ForegroundColor Yellow
        Write-Host ''
        return
    }
    Invoke-Ctl -Command 'stop'
    if (Test-PortInUse) {
        Write-Host "[X] 端口 $Port 仍被占用，可能需要在任务管理器里结束进程。" -ForegroundColor Red
        Write-Host ''
    }
}

function Restart-LayaService {
    Write-Banner '正在重启 Laya 本地决策服务'
    Invoke-Ctl -Command 'stop'
    Start-Sleep -Seconds 2
    Write-Host '[*] 重新启动...' -ForegroundColor Green
    Write-Host ''
    Invoke-Ctl -Command 'start'
    Show-Started
}

function Show-ServiceStatus {
    Write-Banner 'Laya 本地决策服务状态'
    Show-Paths
    Show-ServiceInfo
}

function Invoke-SelfTest {
    Write-Banner '决策自检（按扩展的协议跑一次往返）'
    Write-Host '  注意：服务带 --dump-states 时，这次自检也会落一份真实请求。' -ForegroundColor DarkGray
    Write-Host ''
    Invoke-Ctl -Command 'test'
}

function Show-ServiceLogs {
    Write-Banner '服务日志（末尾 40 行）'
    Invoke-Ctl -Command 'logs' -Extra @{ TailLines = 40 }
}

function Start-LanService {
    Write-Banner '局域网模式启动'
    Write-Host '  会监听所有网卡并生成/复用访问令牌，启动输出里有地址和令牌。' -ForegroundColor DarkGray
    Write-Host '  把地址和令牌给对方填进扩展即可（令牌存在 ~\.laya-server-token）。' -ForegroundColor DarkGray
    Write-Host ''
    if (Test-PortInUse) {
        Write-Host "[!] 端口 $Port 已被占用，先停止再用局域网模式启动。" -ForegroundColor Yellow
        Write-Host ''
        return
    }
    Invoke-Ctl -Command 'start' -Extra @{ Lan = $true }
    Show-Started
}

function Start-ConcurrentService {
    Write-Banner '并发模式启动（供两个标签页同时托管）'
    Write-Host '  本机模型是单实例，两个对局共用它。默认只有 1 个推理 worker，第二个请求要等第一个' -ForegroundColor DarkGray
    Write-Host '  整个跑完——实测 4 题组：单独约 5 秒，成对时变成 18.0 秒 / 8.9 秒（严重不均）。' -ForegroundColor DarkGray
    Write-Host '  这里改成 2 个 worker × 6 线程：两个前向各占 6 个逻辑核，不再互相排队。' -ForegroundColor DarkGray
    Write-Host '  扩展端会自动把本地超时从 18s 放宽到 30s，两个标签页都能继续跑。' -ForegroundColor DarkGray
    Write-Host '  顺便开启请求采集，便于事后分析并发下的真实负载。' -ForegroundColor DarkGray
    Write-Host ''
    if (Test-PortInUse) {
        Write-Host "[!] 端口 $Port 已被占用，先停止（[2]）再用并发模式启动。" -ForegroundColor Yellow
        Write-Host ''
        return
    }
    Invoke-Ctl -Command 'start' -Extra @{ Workers = 2; Threads = 6; DumpStates = $DumpDir }
    Show-Started
}

function Start-SlimService {
    Write-Banner '瘦身状态启动（用于和 [8] 做单一变量对比）'
    Write-Host '  参数与 [8] 完全相同（2 worker × 6 线程 + 采集），只多一个 --slim-state。' -ForegroundColor DarkGray
    Write-Host ''
    Write-Host '  实测代价（同一批 30 份真实请求 / 64 组，对照组一致性 100%）：' -ForegroundColor DarkGray
    Write-Host '    每题 token  2185 -> 1556   (-28.8%)' -ForegroundColor DarkGray
    Write-Host '    平均延迟    2912 -> 1906 ms (-34.5%)' -ForegroundColor DarkGray
    Write-Host '    模型选择一致度 62.5%（即 37.5% 的题组会选不同选项）' -ForegroundColor DarkGray
    Write-Host ''
    Write-Host '  收益：模型第一次能看到 建造队列 / readiness / 威胁评估（现在 95-100% 被截断）；' -ForegroundColor DarkGray
    Write-Host '        延迟降三分之一，直接打击 unit_gone 那类"想好了单位已经死了"的跳过。' -ForegroundColor DarkGray
    Write-Host '  风险：37.5% 的决策改变，好不好只能靠实战判断——所以要和 [8] 打同样的局数再比。' -ForegroundColor DarkGray
    Write-Host ''
    if (Test-PortInUse) {
        Write-Host "[!] 端口 $Port 已被占用，先停止（[2]）再启动。" -ForegroundColor Yellow
        Write-Host ''
        return
    }
    Invoke-Ctl -Command 'start' -Extra @{ Workers = 2; Threads = 6; DumpStates = $DumpDir; SlimState = $true }
    Show-Started
}

function Start-DumpService {
    Write-Banner '抓取模式启动（收集真实请求，供离线分析）'
    Write-Host "  单 worker、device 默认 cuda，只多一个 --dump-states -> $DumpDir" -ForegroundColor DarkGray
    Write-Host '  服务端会把扩展原样发来的 state 与 questions 存成 state-NNNN.json；' -ForegroundColor DarkGray
    Write-Host '  这是唯一能拿到「模型真正读到什么」的途径——战报里存的是数值摘要，不是同一份 schema。' -ForegroundColor DarkGray
    Write-Host ''
    if (Test-PortInUse) {
        Write-Host "[!] 端口 $Port 已被占用，先停止（[2]）再启动。" -ForegroundColor Yellow
        Write-Host ''
        return
    }
    Invoke-Ctl -Command 'start' -Extra @{ DumpStates = $DumpDir }
    Show-Started
}

function Show-Dumps {
    Write-Banner '请求采集概况'
    if (-not (Test-Path $DumpDir)) {
        Write-Host "  目录还不存在：$DumpDir" -ForegroundColor Yellow
        Write-Host '  用菜单 [10]（或 [8]/[9]）启动，并真的打一局或跑一次自检。' -ForegroundColor DarkGray
        Write-Host ''
        return
    }
    $files = @(Get-ChildItem $DumpDir -Filter 'state-*.json' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime)
    if (-not $files.Count) {
        Write-Host "  $DumpDir 里还没有 dump。" -ForegroundColor Yellow
        Write-Host ''
        return
    }
    Write-Host "  共 $($files.Count) 份，最新 $($files[-1].LastWriteTime)" -ForegroundColor Green
    Write-Host ''
    $report = Join-Path $Repo 'tools\laya-state-report.py'
    if ((Test-Path $report) -and (Test-Path $VenvPython)) {
        Write-Host '  字段截断命中率（哪些字段从来没进过模型）：' -ForegroundColor Cyan
        # --model 必须显式传：工具的默认值是「和仓库同级」的 models\laya-multilingual，
        # 而本机模型在离线包里，不传就报 HFValidationError（它会把路径当成 HF repo id）。
        # 两个 OFFLINE 变量是必需的：否则 transformers 会试着联网解析本地路径。
        $env:HF_HUB_OFFLINE = '1'
        $env:TRANSFORMERS_OFFLINE = '1'
        & $VenvPython $report $DumpDir --model $ModelDir
        Remove-Item Env:\HF_HUB_OFFLINE -ErrorAction SilentlyContinue
        Remove-Item Env:\TRANSFORMERS_OFFLINE -ErrorAction SilentlyContinue
    } else {
        Write-Host "  （缺 $report 或 venv，跳过字段统计）" -ForegroundColor Yellow
    }
    Write-Host ''
}

function Show-Reports {
    Write-Banner '最新战报分析'
    if (-not (Test-Path $ReportsDir)) {
        Write-Host "  战报目录不存在：$ReportsDir" -ForegroundColor Yellow
        Write-Host ''
        return
    }
    $newest = Get-ChildItem $ReportsDir -Filter 'jev-report-*.json' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime | Select-Object -Last 1
    if (-not $newest) {
        Write-Host '  还没有战报。开托管打一局，结束后扩展会自动写一份。' -ForegroundColor Yellow
        Write-Host ''
        return
    }
    Write-Host "  最新：$($newest.Name)" -ForegroundColor Green
    Write-Host ''
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { Write-Host '  找不到 node，无法运行分析工具。' -ForegroundColor Red; Write-Host ''; return }
    foreach ($t in @(
        @{ f = 'option-report.mjs';   d = '候选生命周期：从未生效的族 / 模型从未见过 / 引擎独占 / 强制题' },
        @{ f = 'fallback-report.mjs'; d = 'auto:N 兜底：可触发 / 模型拒 / 模型自选 / 实际触发' },
        @{ f = 'reward-report.mjs';   d = '决策收益窗口：窗口内资金 / 兵力 / 敌军 / 损失 / 击毁 / 交换' }
    )) {
        $tool = Join-Path $Repo ('tools\' + $t.f)
        if (-not (Test-Path $tool)) { Write-Host "  [--] 缺工具 $($t.f)" -ForegroundColor DarkGray; continue }
        Write-Host '----------------------------------------' -ForegroundColor DarkGray
        Write-Host "  $($t.d)" -ForegroundColor Cyan
        Write-Host '----------------------------------------' -ForegroundColor DarkGray
        & node $tool $newest.FullName
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  [!] $($t.f) 退出码 $LASTEXITCODE（战报构建早于该记录时属正常）" -ForegroundColor Yellow
        }
        Write-Host ''
    }
}

function Show-EnvCheck {
    Write-Banner '环境自检'
    Show-Paths
    if (Test-Path $VenvPython) { Write-Host "  python:  $VenvPython" -ForegroundColor Green }
    else { Write-Host "  python:  缺失 $VenvPython" -ForegroundColor Red }
    if (Test-Path (Join-Path $ModelDir 'model.safetensors')) { Write-Host "  模型:    $ModelDir" -ForegroundColor Green }
    else { Write-Host "  模型:    缺失 $ModelDir" -ForegroundColor Red }
    if (Test-Path $Ctl) { Write-Host "  控制脚本: $Ctl" -ForegroundColor Green }
    else { Write-Host "  控制脚本: 缺失 $Ctl" -ForegroundColor Red }
    Write-Host ''
    Show-ServiceInfo
}

function Open-Folders {
    foreach ($p in @($DumpDir, $ReportsDir, $BuildDir, $Repo)) {
        if (Test-Path $p) { Start-Process explorer.exe $p }
    }
}

function Show-Menu {
    Clear-Screen
    Write-Host '========================================' -ForegroundColor Cyan
    Write-Host '  Laya 本地决策服务管理器' -ForegroundColor Cyan
    Write-Host '========================================' -ForegroundColor Cyan
    Write-Host ''
    Write-Host '  [1] 启动服务' -ForegroundColor White
    Write-Host '  [2] 停止服务' -ForegroundColor White
    Write-Host '  [3] 重启服务' -ForegroundColor White
    Write-Host '  [4] 查看状态' -ForegroundColor White
    Write-Host '  [5] 决策自检' -ForegroundColor White
    Write-Host '  [6] 查看日志' -ForegroundColor White
    Write-Host '  [7] 局域网模式启动' -ForegroundColor White
    Write-Host '  [8] 并发模式启动（基线，2 个标签页）' -ForegroundColor White
    Write-Host '  [9] 瘦身状态启动（[8] + --slim-state）' -ForegroundColor White
    Write-Host ''
    Write-Host '  [10] 抓取模式启动（收集真实请求）' -ForegroundColor Green
    Write-Host '  [11] 采集概况 + 字段截断命中率' -ForegroundColor Green
    Write-Host '  [12] 分析最新战报（三个工具）' -ForegroundColor Green
    Write-Host '  [13] 环境自检' -ForegroundColor Green
    Write-Host '  [14] 打开目录（采集 / 战报 / dist / 仓库）' -ForegroundColor Green
    Write-Host ''
    Write-Host '  [0] 退出' -ForegroundColor Red
    Write-Host ''
    Write-Host "  端口: $Port" -ForegroundColor DarkGray
    Write-Host "  仓库: $Repo" -ForegroundColor DarkGray
    Write-Host "  整合包: $Bundle" -ForegroundColor DarkGray
    Write-Host "  采集: $DumpDir" -ForegroundColor DarkGray
    Write-Host '========================================' -ForegroundColor Cyan
}

function Invoke-One {
    param([string]$Name)
    switch ($Name.ToLower()) {
        'status'  { Show-ServiceStatus }
        'start'   { Start-LayaService }
        'stop'    { Stop-LayaService }
        'restart' { Restart-LayaService }
        'test'    { Invoke-SelfTest }
        'logs'    { Show-ServiceLogs }
        'lan'     { Start-LanService }
        'dump'    { Start-DumpService }
        'dumps'   { Show-Dumps }
        'reports' { Show-Reports }
        'env'     { Show-EnvCheck }
        default   { Write-Host "未知命令：$Name（可用 status/start/stop/restart/test/logs/lan/dump/dumps/reports/env）" -ForegroundColor Yellow; Write-Host '' }
    }
}

# 非交互模式：给了 -Command 就跑一条然后退出，方便脚本调用与自动化验证。
if ($Command) {
    Invoke-One $Command
    exit 0
}

do {
    Show-Menu
    $choice = Read-Host '请选择操作 (0-14)'

    switch ($choice) {
        '1'  { Start-LayaService }
        '2'  { Stop-LayaService }
        '3'  { Restart-LayaService }
        '4'  { Show-ServiceStatus }
        '5'  { Invoke-SelfTest }
        '6'  { Show-ServiceLogs }
        '7'  { Start-LanService }
        '8'  { Start-ConcurrentService }
        '9'  { Start-SlimService }
        '10' { Start-DumpService }
        '11' { Show-Dumps }
        '12' { Show-Reports }
        '13' { Show-EnvCheck }
        '14' { Open-Folders }
        '0'  {
            Write-Host ''
            Write-Host '再见!' -ForegroundColor Cyan
            Write-Host ''
            exit 0
        }
        default {
            Write-Host ''
            Write-Host '[!] 无效的选项，请重新选择' -ForegroundColor Red
            Write-Host ''
        }
    }

    if ($choice -ne '0') { Read-Host '按回车键继续' | Out-Null }
} while ($true)
