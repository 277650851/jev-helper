@echo off
rem Baseline arm (arm A, CONTROL): 2 workers x 6 threads + request capture, WITHOUT --slim-state.
rem The only difference from run-slim.cmd is the --slim-state flag, so the two arms differ by one
rem variable and nothing else. For daily play use run-slim.cmd; this arm is kept for comparison --
rem it sits at 1022 tokens/question, hits Laya's 1024 cap on 100%% of questions, and has army /
rem queues / economy / forceReadiness cut in 100%% of them.
rem
rem Why not the manage-laya.cmd menu: the menu script (manage-laya.ps1) takes the server down with it
rem when it exits. A server started through laya-ctl.cmd keeps running.
rem
rem Keep this file ASCII-only. cmd.exe reads batch files in the OEM code page, so UTF-8 text in a rem
rem line is decoded as garbage and can break the line into commands that then get executed.
setlocal
pushd "%~dp0"

echo.
echo == Stopping any running server...
call tools\laya-ctl.cmd stop

echo.
echo == Starting BASELINE mode (no --slim-state)...
call tools\laya-ctl.cmd start -Workers 2 -Threads 6 -DumpStates .preview\states

popd
echo.
echo ---------------------------------------------------------------
echo  BASELINE mode is up (no --slim-state).
echo.
echo  Next: open exactly ONE game tab and start autopilot there.
echo  Play 2-3 matches. Do not restart the server mid-match and do
echo  not host a second tab during this test.
echo  Then export the reports from the dashboard and send them over.
echo ---------------------------------------------------------------
echo.
pause
