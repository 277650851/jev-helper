#requires -Version 5.1
<#
    Jev 托管 AI - 本地 Laya 离线整合包：启动器。

    必须存成 UTF-8 with BOM。cmd.exe 按 ANSI 代码页解析 .cmd，所以中文文案全部放在这里
    （PowerShell 认得 BOM），启动.cmd 只负责转发。

    参数原样转交 tools\laya-ctl.ps1，并把本包里的解释器和检查点路径告诉它。
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Command = 'run'
)

$ErrorActionPreference = 'Continue'
# This script sits in the bundle root, not in tools/, so $PSScriptRoot already *is* the root.
# Taking its parent would climb out of the bundle entirely.
$Root = $PSScriptRoot
$Python = Join-Path $Root 'venv\Scripts\python.exe'
$Model = Join-Path $Root 'model\laya-multilingual'
$Ctl = Join-Path $Root 'tools\laya-ctl.ps1'
$Check = Join-Path $Root 'tools\laya-check.py'

if (-not (Test-Path $Python)) {
    Write-Host ''
    Write-Host '  [错误] 找不到 Python 环境：' $Python -ForegroundColor Red
    Write-Host '         这个整合包不完整，请重新拷贝整个目录。' -ForegroundColor Red
    Write-Host ''
    Read-Host '按回车关闭'
    exit 1
}

# `run` 不是 laya-ctl 的子命令：它是"启动 + 自检 + 打印后续步骤"这一整套。
if ($Command -eq 'run') {
    Write-Host ''
    Write-Host '  ============================================================' -ForegroundColor Cyan
    Write-Host '   Jev 托管 AI - 本地 Laya 决策服务' -ForegroundColor Cyan
    Write-Host '  ============================================================' -ForegroundColor Cyan
    Write-Host ''

    & $Ctl start -Python $Python -Model $Model -Device cuda
    if ($LASTEXITCODE -ne 0) {
        Write-Host ''
        Write-Host '  启动失败，请看上方的报错。常见原因见 使用说明.md 第 8 节。' -ForegroundColor Red
        Write-Host ''
        Read-Host '按回车关闭'
        exit 1
    }

    Write-Host ''
    Write-Host '  [自检] 发一次真实决策请求 ...' -ForegroundColor Cyan
    Write-Host ''
    & $Python $Check
    if ($LASTEXITCODE -ne 0) {
        Write-Host ''
        Write-Host '  服务已启动，但决策自检没通过。' -ForegroundColor Red
        Write-Host '  扩展会拒绝不遵守协议的模型回答，所以这一步必须过。' -ForegroundColor Red
        Write-Host '  详情看上方输出，以及 .laya-server.err.log' -ForegroundColor Red
        Write-Host ''
        Read-Host '按回车关闭'
        exit 1
    }

    Write-Host ''
    Write-Host '  ============================================================' -ForegroundColor Green
    Write-Host '   已就绪' -ForegroundColor Green
    Write-Host '  ============================================================' -ForegroundColor Green
    Write-Host ''
    Write-Host '   1) 浏览器打开  chrome://extensions   (Edge 是 edge://extensions)'
    Write-Host '   2) 右上角开启「开发者模式」'
    Write-Host '   3) 点「加载已解压的扩展程序」，选择本目录下的  extension  文件夹'
    Write-Host '   4) 打开游戏页面 -> 扩展弹窗 -> 设置'
    Write-Host '        模型来源：本地 Laya'
    Write-Host '        服务地址：http://127.0.0.1:8742/v1   (默认值，不用改)'
    Write-Host '        访问令牌：留空'
    Write-Host '        模型名称：laya'
    Write-Host '      点「保存设置」，浏览器询问是否允许访问该地址时点「允许」'
    Write-Host '      再点「测试模型连接」，按钮变绿即可'
    Write-Host '   5) 进入对局，点「开启托管」'
    Write-Host ''
    Write-Host '   停止服务：运行  启动.cmd stop'
    Write-Host '   本包说明：使用说明.md'
    Write-Host ''
    Read-Host '按回车关闭'
    exit 0
}

# 其余子命令（status / stop / restart / test / logs / fetch / help）直接转交。
& $Ctl $Command -Python $Python -Model $Model
exit $LASTEXITCODE