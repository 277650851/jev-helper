@echo off
rem One-key entry point for the local Laya server, for cmd.exe and double-click use.
rem   tools\laya-ctl.cmd status
rem   tools\laya-ctl.cmd start
rem   tools\laya-ctl.cmd test
rem   tools\laya-ctl.cmd stop
rem The real work lives in laya-ctl.ps1 next to this file.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0laya-ctl.ps1" %*
exit /b %ERRORLEVEL%
