@echo off
rem Slim arm (arm B, RECOMMENDED): 2 workers x 6 threads + request capture, WITH --slim-state.
rem The only difference from run-baseline.cmd is the --slim-state flag.
rem
rem Why this arm: the full state is ~1022 tokens per question and hits Laya's 1024 cap on 100%% of
rem questions, with army / queues / economy / forceReadiness / decisionReadiness cut in 100%% of them.
rem The model is handed a state it cannot finish reading, so it cannot see the build queue or whether
rem production is allowed. The slim arm sits at 666-712 tokens, hits the cap 0%% of the time, and has
rem those fields cut in 1%%.
rem
rem Live A/B, 10 matches split by the model's own token signature (not by the clock -- the server was
rem restarted during the evening), 5 per arm: tokens/question 1024 -> 712; latency bucketed by
rem question count so the workload matches, 15-24%% lower in every bucket; auto-override rate
rem 13.3%% -> 9.5%%; overall wait rate 62.5%% -> 53.2%%; production-group waits vehicles 89%% -> 70%%
rem and infantry 90%% -> 68%%. Only skips got worse, 8.0 -> 10.1 per 100 question groups.
rem
rem Not measured: win rate. The arms were not played for comparable time (149 vs 55 minutes), and
rem wins are too low-frequency to read from a handful of matches.
rem
rem Keep this file ASCII-only (see run-baseline.cmd for why).
setlocal
pushd "%~dp0"

echo.
echo == Stopping any running server...
call tools\laya-ctl.cmd stop

echo.
echo == Starting SLIM mode (--slim-state)...
call tools\laya-ctl.cmd start -Workers 2 -Threads 6 -DumpStates .preview\states -SlimState

popd
echo.
echo ---------------------------------------------------------------
echo  SLIM mode is up (--slim-state).
echo.
echo  Next: open exactly ONE game tab and start autopilot there.
echo  Play 2-3 matches. Do not restart the server mid-match and do
echo  not host a second tab during this test.
echo  Then export the reports from the dashboard and send them over.
echo ---------------------------------------------------------------
echo.
pause
