@echo off
rem Jev  AI -  Laya 
rem ASCII only on purpose: cmd.exe parses a .cmd using the ANSI codepage (GBK on a Chinese
rem Windows), so UTF-8 Chinese text in this file would be read as mojibake. All Chinese output
rem lives in the PowerShell script next to it, which is saved as UTF-8 with a BOM and is read
rem correctly. This file only dispatches.
rem
rem   .cmd            start + self-test   (double-click default)
rem   .cmd status     what is running
rem   .cmd stop       stop the server
rem   .cmd restart    stop, then start
rem   .cmd test       protocol self-check only
rem   .cmd logs       tail of the server log
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch.ps1" %*
exit /b %ERRORLEVEL%