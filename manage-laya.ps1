#requires -Version 5.1
<#
    Laya 本地决策服务管理器（交互式菜单）

    用法:
        .\manage-laya.ps1              # 或在资源管理器里双击 manage-laya.cmd
        .\manage-laya.ps1 -Port 8743   # 换端口（记得扩展里同步改）

    说明:
        启动/停止/状态/自检/日志这些实际操作，全部转交给 tools\laya-ctl.ps1 执行。
        本脚本只负责菜单和显示。这样端口、PID 文件、健康检查、权重校验只有一份实现，
        不会出现"菜单里能停、命令行停不掉"这类漂移。

    注意:
        本文件必须保存为「UTF-8 with BOM」。Windows PowerShell 5.1 会按系统 ANSI
        （中文系统上是 GBK）解码没有 BOM 的 .ps1，中文会变成乱码并把引号吃掉，
        脚本直接报语法错误。
#>
[CmdletBinding()]
param(
    # 服务端口。扩展默认连 8742。
    [int]$Port = 8742
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Root = $PSScriptRoot
$Ctl = Join-Path $Root 'tools\laya-ctl.ps1'
$VenvPython = Join-Path $Root '.laya-venv\Scripts\python.exe'
$ModelDir = Join-Path $Root 'models\laya-multilingual'
$HealthUrl = "http://127.0.0.1:$Port/health"

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

    # Which state encoding the running server was started with. [8] and [9] differ by exactly one flag
    # and produce visibly different play, and a server started earlier keeps running after the menu
    # exits -- so "which arm am I on" cannot be guessed from outside. Ask the listener's own command
    # line. Without this line the menu reported the same status for both arms, which is how [9] looked
    # identical to [8] from in here.
    if ($listener) {
        $cmdline = (Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.Pid)" -ErrorAction SilentlyContinue).CommandLine
        if ($cmdline -match '--slim-state') { Write-Host '  状态编码:   瘦身（--slim-state，[9] 臂）' -ForegroundColor Yellow }
        elseif ($cmdline -match '--lean-state') { Write-Host '  状态编码:   精简（--lean-state）' -ForegroundColor Yellow }
        elseif ($cmdline -match '--compact-units') { Write-Host '  状态编码:   单位压缩（--compact-units）' -ForegroundColor Yellow }
        elseif ($cmdline) { Write-Host '  状态编码:   完整（默认，[1]/[8] 臂）' -ForegroundColor Green }
    }

    Write-Host '  接口地址: ' -NoNewline
    Write-Host "http://127.0.0.1:$Port/v1/systemone"
    Write-Host '  健康检查: ' -NoNewline
    Write-Host "http://127.0.0.1:$Port/health"

    Write-Host '  运行环境: ' -NoNewline
    if (Test-Path $VenvPython) { Write-Host '.laya-venv 就绪' -ForegroundColor Green }
    else { Write-Host '缺少 .laya-venv（先跑 install.ps1）' -ForegroundColor Yellow }

    Write-Host '  模型权重: ' -NoNewline
    if (Test-Path (Join-Path $ModelDir 'model.safetensors')) { Write-Host '完整' -ForegroundColor Green }
    else { Write-Host "缺失（$ModelDir）" -ForegroundColor Red }

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
function Invoke-Ctl {
    param(
        [Parameter(Mandatory)][string]$Command,
        [hashtable]$Extra = @{}
    )
    if (-not (Test-Path $Ctl)) {
        Write-Host "[X] 找不到 $Ctl，安装包不完整。" -ForegroundColor Red
        Write-Host ''
        return
    }
    $bound = @{ Command = $Command; Port = $Port }
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
    Invoke-Ctl -Command 'start'
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
    Show-ServiceInfo
}

function Invoke-SelfTest {
    Write-Banner '决策自检（按扩展的协议跑一次往返）'
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
    Write-Host '  顺便开启请求采集（.preview\states），便于事后分析并发下的真实负载。' -ForegroundColor DarkGray
    Write-Host ''
    Write-Host '  注意：这是**完整状态**臂 —— 每题 1022 token，100% 撞 1024 上限，army / queues /' -ForegroundColor Yellow
    Write-Host '  economy / forceReadiness 全部 100% 被截断。日常托管建议用 [9] 瘦身臂；这里保留是为了对照。' -ForegroundColor Yellow
    Write-Host ''
    if (Test-PortInUse) {
        Write-Host "[!] 端口 $Port 已被占用，先停止（[2]）再用并发模式启动。" -ForegroundColor Yellow
        Write-Host ''
        return
    }
    Invoke-Ctl -Command 'start' -Extra @{ Workers = 2; Threads = 6; DumpStates = (Join-Path $Root '.preview\states') }
    Show-Started
}

function Start-SlimService {
    Write-Banner '瘦身状态启动（推荐）'
    Write-Host '  参数与 [8] 完全相同（2 worker × 6 线程 + 采集），只多一个 --slim-state。' -ForegroundColor DarkGray
    Write-Host ''
    Write-Host '  为什么推荐瘦身臂 —— 完整状态是模型读不完的状态：' -ForegroundColor Yellow
    Write-Host '    完整臂每题 1022 token，100% 撞 Laya 的 1024 上限；' -ForegroundColor DarkGray
    Write-Host '      army / queues / economy / forceReadiness / decisionReadiness 全部 100% 被截断，' -ForegroundColor DarkGray
    Write-Host '      也就是说模型根本读不到建造队列、部队构成和"现在能不能生产"。' -ForegroundColor DarkGray
    Write-Host '    瘦身臂每题 666-712 token，0% 撞上限，同样这些字段只有 1% 被截断。' -ForegroundColor DarkGray
    Write-Host ''
    Write-Host '  实机 A/B（10 局，按模型 token 签名分臂，各 5 局；不用时钟分，因为服务中途重启过）：' -ForegroundColor DarkGray
    Write-Host '      每题 token       1024 -> 712' -ForegroundColor DarkGray
    Write-Host '      延迟（按题组数分层，负载匹配）1 组 2099 -> 1627，3 组 6045 -> 5137，5 组 10356 -> 7888 ms' -ForegroundColor DarkGray
    Write-Host '      每百题组被跳过   8.0 -> 10.1   （唯一变差的一项）' -ForegroundColor DarkGray
    Write-Host '      自动兜底占比     13.3% -> 9.5%  （瘦身臂更少要人接管）' -ForegroundColor DarkGray
    Write-Host '      总等待率         62.5% -> 53.2%' -ForegroundColor DarkGray
    Write-Host '      生产组等待率     vehicles 89% -> 70%，infantry 90% -> 68%' -ForegroundColor DarkGray
    Write-Host ''
    Write-Host '  以前记录里说"瘦身臂被否掉"的三条理由，10 局这批里有两条没复现：' -ForegroundColor DarkGray
    Write-Host '    target_no_longer_visible：两臂都是 0（原记录说 0 -> 6）' -ForegroundColor DarkGray
    Write-Host '    construction 等待率：36% vs 40%（原记录说 43% -> 69%，n=55/42，差异在噪声内）' -ForegroundColor DarkGray
    Write-Host '    只剩"决策被浪费比例上升"一条方向成立，但幅度小得多（8.0 -> 10.1，不是 10.6 -> 14.7）。' -ForegroundColor DarkGray
    Write-Host ''
    Write-Host '  没测的：胜负。两臂游戏时长差 2.7 倍（149 分钟 vs 55 分钟），战败这种低频事件没法读，' -ForegroundColor DarkGray
    Write-Host '  所以这个推荐是建立在机制和负载匹配延迟上的，不是建立在胜率上的。' -ForegroundColor DarkGray
    Write-Host '  想复现对照臂用 [8]。' -ForegroundColor DarkGray
    Write-Host ''
    if (Test-PortInUse) {
        Write-Host "[!] 端口 $Port 已被占用，先停止（[2]）再启动。" -ForegroundColor Yellow
        Write-Host ''
        return
    }
    Invoke-Ctl -Command 'start' -Extra @{ Workers = 2; Threads = 6; DumpStates = (Join-Path $Root '.preview\states'); SlimState = $true }
    Show-Started
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
    Write-Host '  [8] 并发模式启动（完整状态，作为对照臂）' -ForegroundColor White
    Write-Host '  [9] 并发模式启动（瘦身状态，推荐）' -ForegroundColor White
    Write-Host ''
    Write-Host '  [0] 退出' -ForegroundColor Red
    Write-Host ''
    Write-Host "  端口: $Port    目录: $Root" -ForegroundColor DarkGray
    Write-Host '========================================' -ForegroundColor Cyan
}

do {
    Show-Menu
    $choice = Read-Host '请选择操作 (0-9)'

    switch ($choice) {
        '1' { Start-LayaService }
        '2' { Stop-LayaService }
        '3' { Restart-LayaService }
        '4' { Show-ServiceStatus }
        '5' { Invoke-SelfTest }
        '6' { Show-ServiceLogs }
        '7' { Start-LanService }
        '8' { Start-ConcurrentService }
        '9' { Start-SlimService }
        '0' {
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
