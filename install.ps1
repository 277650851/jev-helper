#requires -Version 5.1
<#
    离线安装：本地 Laya 决策模型的运行环境。

    这个脚本不打补丁、不碰源码，只做三件事：
      1. 用系统 Python 建一个 .laya-venv 虚拟环境；
      2. 从随包的 wheels/ 目录离线安装依赖（--no-index，全程不联网）；
      3. 校验模型权重完整，并（默认）跑一次真实的决策往返作为验收。

    为什么要 wheels 而不是直接附带 .laya-venv：Windows 上的 venv 不可搬迁，pyvenv.cfg 里记的是
    绝对路径，换台机器或换个目录就失效。wheels 没有这个问题，体积也更小（约 250 MB vs 822 MB）。

    前提只有一个：目标机器装好 64 位 Python 3.10+（python.org 安装包，勾选 "Add python.exe to PATH"）。
    torch 的 wheel 与 Python 版本、平台绑定，本包里的 wheels 是 win_amd64 + cp313 构建。

    用法：
      powershell -ExecutionPolicy Bypass -File install.ps1
      powershell -ExecutionPolicy Bypass -File install.ps1 -SkipVerify
      powershell -ExecutionPolicy Bypass -File install.ps1 -Port 8743
#>
[CmdletBinding()]
param(
    # 只装依赖并校验权重，不起服务（装机时想快一点可以用）。
    [switch]$SkipVerify,
    # 服务端口。扩展默认连 8742，改这里就得同时改扩展设置。
    [int]$Port = 8742,
    # 显式指定 Python 解释器（默认自动找 python / py -3）。
    [string]$Python = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Root = $PSScriptRoot
$VenvDir = Join-Path $Root '.laya-venv'
$VenvPython = Join-Path $VenvDir 'Scripts\python.exe'
$WheelsDir = Join-Path $Root 'wheels'
$ReqFile = Join-Path $Root 'requirements.txt'
$ModelDir = Join-Path $Root 'models\laya-multilingual'
$CheckpointFiles = @('model.safetensors', 'rl_agent_config.json', 'configuration.json',
                     'encoder\config.json', 'tokenizer\tokenizer.json', 'tokenizer\tokenizer_config.json')

function Say($text, $colour = 'Gray') { Write-Host $text -ForegroundColor $colour }
function Step($text) { Write-Host ''; Write-Host "== $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "  [ok] $text" -ForegroundColor Green }
function Bad($text) { Write-Host "  [!!] $text" -ForegroundColor Yellow }
function Die($text) { Write-Host "  [xx] $text" -ForegroundColor Red; exit 1 }

Say ''
Say '  jev-helper 离线部署 · 本地 Laya 决策模型' 'White'
Say '  ----------------------------------------' 'DarkGray'
Say "  安装目录：$Root"
Say "  服务端口：$Port"

# ---------------------------------------------------------------- 1. 检查随包文件
Step '检查随包文件'
if (-not (Test-Path $WheelsDir)) { Die "缺少 wheels\ 目录，安装包不完整。" }
$wheelCount = (Get-ChildItem $WheelsDir -Filter *.whl -File | Measure-Object).Count
if ($wheelCount -lt 10) { Die "wheels\ 里只有 $wheelCount 个 wheel，安装包不完整。" }
Ok "wheels\：$wheelCount 个离线包"
if (-not (Test-Path $ReqFile)) { Die '缺少 requirements.txt。' }
Ok 'requirements.txt：有'

$missing = @()
foreach ($rel in $CheckpointFiles) { if (-not (Test-Path (Join-Path $ModelDir $rel))) { $missing += $rel } }
if ($missing.Count) { Die "模型权重不完整，缺少：$($missing -join ', ')" }
$modelMb = [math]::Round((Get-ChildItem $ModelDir -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1)
Ok "模型权重：$ModelDir（$modelMb MB）"

# ---------------------------------------------------------------- 2. 找 Python
Step '查找 Python 3.10+（64 位）'
$candidates = @()
if ($Python) { $candidates += @{ exe = $Python; args = @() } }
$candidates += @{ exe = 'python'; args = @() }, @{ exe = 'py'; args = @('-3') }

# The probe is a file, not an inline `-c` script: Windows PowerShell 5.1 mangles embedded double
# quotes when it forwards arguments to a native program, and Python then saw the quotes stripped and
# failed with a syntax error - which looked exactly like "no Python installed".
$ProbeScript = Join-Path $Root 'tools\python-probe.py'
if (-not (Test-Path $ProbeScript)) { Die '缺少 tools\python-probe.py，安装包不完整。' }

$base = $null
foreach ($c in $candidates) {
    $probe = $null
    # A missing interpreter writes to stderr, and 'Stop' would turn that into a terminating error
    # before the next candidate could be tried.
    $relaxed = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $probe = & $c.exe @($c.args + @($ProbeScript)) 2>$null } catch { $probe = $null }
    finally { $ErrorActionPreference = $relaxed }
    $code = $LASTEXITCODE
    $lines = @($probe | Where-Object { $_ })
    if ($code -ne 0 -or $lines.Count -lt 2) { continue }
    $ver = [version]$lines[0]; $bits = [int]$lines[1]
    if ($ver -lt [version]'3.10') { Bad "$($c.exe)：Python $ver 过旧（需要 3.10+）"; continue }
    if ($bits -ne 64) { Bad "$($c.exe)：$bits 位，torch 需要 64 位"; continue }
    $base = @{ exe = $c.exe; args = $c.args; version = $ver }
    break
}
if (-not $base) {
    Step '没有可用的 Python'
    Say '  这个包需要目标机器先装 64 位 Python 3.10 或更高版本：'
    Say '    https://www.python.org/downloads/windows/'
    Say '  安装时务必勾选 "Add python.exe to PATH"，装完重开一个终端再跑本脚本。'
    Say "  已经装在非默认位置的话，可以指定：install.ps1 -Python 'C:\Python313\python.exe'"
    exit 1
}
$baseArgs = if (@($base.args).Count) { ' ' + ($base.args -join ' ') } else { '' }
Ok "Python $($base.version)：$($base.exe)$baseArgs"

# ---------------------------------------------------------------- 3. 建虚拟环境
Step '准备虚拟环境 .laya-venv'
if (Test-Path $VenvPython) {
    Ok '已存在，复用（要重建就删掉 .laya-venv 目录再跑）'
} else {
    & $base.exe @($base.args + @('-m', 'venv', $VenvDir))
    if (-not (Test-Path $VenvPython)) { Die 'venv 创建失败。' }
    Ok '已创建'
}

# ---------------------------------------------------------------- 4. 离线安装依赖
Step '离线安装依赖（--no-index，不联网）'
Say '  torch 约 124 MB，第一次装要几分钟，请勿中断。' 'DarkGray'
& $VenvPython -m pip install --no-index --find-links $WheelsDir -r $ReqFile --disable-pip-version-check --no-input
if ($LASTEXITCODE -ne 0) {
    Step '依赖安装失败'
    Say '  常见原因：' 'DarkGray'
    Say '    · Python 版本与本包 wheels 不匹配（本包是 cp313 / win_amd64）' 'DarkGray'
    Say '    · 目标机器不是 64 位 Windows' 'DarkGray'
    Die 'pip 退出码 ' + $LASTEXITCODE
}
Ok '依赖安装完成'

# ---------------------------------------------------------------- 5. 导入自检
Step '导入自检'
$probe = & $VenvPython -c "import laya,torch,fastapi,uvicorn;print('laya',laya.__version__);print('torch',torch.__version__);print('fastapi',fastapi.__version__)"
if ($LASTEXITCODE -ne 0) { Die "依赖装上了但导入失败：`n$probe" }
foreach ($line in @($probe)) { Ok $line }

# ---------------------------------------------------------------- 6. 启动并验收
if ($SkipVerify) {
    Step '跳过验收（-SkipVerify）'
    Say '  需要验收时单独跑：tools\laya-ctl.cmd test'
} else {
    Step '启动服务并做一次真实决策往返'
    Say '  模型加载约 8-20 秒……' 'DarkGray'
    # Not piped: the server is a long-lived child of the launcher, and sending the launcher's output
    # through a pipeline leaves that pipe open until the server stops, which hangs the installer.
    & (Join-Path $Root 'tools\laya-ctl.ps1') start -Port $Port
    $health = $null
    for ($i = 0; $i -lt 60 -and -not $health; $i++) {
        Start-Sleep -Milliseconds 750
        try { $health = Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 3 } catch { }
    }
    if (-not $health) { Die "服务在 $Port 端口没有起来，看日志：tools\laya-ctl.cmd logs" }
    Ok "健康检查：status=$($health.status) device=$($health.device) loaded=$($health.loaded -join ',')"

    & $VenvPython (Join-Path $Root 'tools\laya-check.py') --url "http://127.0.0.1:$Port/v1"
    if ($LASTEXITCODE -ne 0) { Die '决策往返失败，见上面的输出。' }
    Ok '验收通过：模型按扩展的协议正确作答'
}

# ---------------------------------------------------------------- 7. 下一步
Step '接下来做什么'
Say ''
Say '  1) 服务保持后台运行。要手动管理：' 'White'
Say "       tools\laya-ctl.cmd status     查看状态与模型" 'Gray'
Say '       tools\laya-ctl.cmd start      启动' 'Gray'
Say '       tools\laya-ctl.cmd stop       停止' 'Gray'
Say '       tools\laya-ctl.cmd test       再跑一次决策自检' 'Gray'
Say ''
Say '  2) 在 Edge/Chrome 里加载扩展：' 'White'
Say "       chrome://extensions 或 edge://extensions → 开发者模式 → 加载解压缩的扩展" 'Gray'
# Read the shipped zip's name instead of hard-coding a version: the literal here said 0.8.0 while
# the package shipped 0.8.3, which sends the reader looking for a file that is not there.
$extZip = Get-ChildItem (Join-Path $Root 'artifacts\*.zip') -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime | Select-Object -Last 1
$extHint = if ($extZip) { $extZip.Name } else { '（本包 artifacts\ 里没有扩展压缩包，直接用 dist\）' }
Say "       选 dist\ 目录（或用 artifacts\$extHint 解压后再加载）" 'Gray'
Say ''
Say '  3) 打开扩展设置，把「模型来源」切到「本地 Laya」，地址填：' 'White'
Say "       http://127.0.0.1:$Port/v1" 'Gray'
Say '     本地模型名保持 laya-multilingual 不用改；本机模式不需要令牌。' 'Gray'
Say '     点「保存设置」并允许站点访问，再点「测试模型连接」应显示成功。' 'Gray'
Say ''
Say '  4) 进对局，开启托管。悬浮窗会显示当前来源为 Laya。' 'White'
Say ''
