@echo off
rem Slim state mode (the only mode to play): 2 workers x 6 threads + request capture, WITH
rem --slim-state. This is the daily entry point; there is no full-state counterpart any more.
rem
rem Why slim and not the full state: the full state is ~1022 tokens per question and hits Laya's
rem 1024 cap on 100%% of questions, with army / queues / economy / forceReadiness / decisionReadiness
rem cut in 100%% of them. The model is handed a state it cannot finish reading, so it cannot see the
rem build queue or whether production is allowed. The slim arm sits at 666-712 tokens, hits the cap
rem 0%% of the time, and has those fields cut in 1%%.
rem
rem Measured A/B, 10 matches split by the model's own token signature (not by the clock -- the server
rem was restarted during the evening), 5 per arm: tokens/question 1024 -> 712; latency bucketed by
rem question count so the workload matches, 15-24%% lower in every bucket; auto-override rate
rem 13.3%% -> 9.5%%; overall wait rate 62.5%% -> 53.2%%; production-group waits vehicles 89%% -> 70%%
rem and infantry 90%% -> 68%%. Only skips got worse, 8.0 -> 10.1 per 100 question groups.
rem
rem Not measured: win rate. The arms were not played for comparable time (149 vs 55 minutes), and
rem wins are too low-frequency to read from a handful of matches.
rem
rem -HeadMaxLen 512 is not about state size at all, it is about the instructions. Laya caps every
rem option at 48 tokens and gives the instructions whatever budget is left, so the checkpoint default
rem of 256 leaves the vehicle instructions (273 tokens) only 109 -- and the sentence that decides the
rem question, "ECONOMY FIRST: ... Produce the offered miner now", sits at the end and was being cut
rem off before the model ever saw it. Measured on 20 real captured vehicle questions against
rem laya-multilingual: wait answered 18 of 20 at 256, 4 of 20 at 512. Costs 1052 -> 1431 ms.
rem Raising the whole sequence to 8192 instead does almost nothing for this (mixed action rate 57% ->
rem 63%) and costs four times the latency, so max_len stays at the checkpoint's 1024.
rem
rem What the full-state arm actually cost, in a real match (jev-report-20261009-052739): the vehicle
rem queue sat empty for 20.6 minutes with 3700-5000 credits on hand and a 750-credit tank on offer,
rem and the model answered wait 29 times out of 29, at 0.65-0.93 confidence. One tank was built and
rem the base fell. It was not choosing badly -- it could not see that the queue was empty.
rem
rem Keep this file ASCII-only. cmd.exe reads batch files in the OEM code page, so UTF-8 text in a rem
rem line is decoded as garbage and can break the line into commands that then get executed.
setlocal
pushd "%~dp0"

echo.
echo == Stopping any running server...
call tools\laya-ctl.cmd stop

echo.
echo == Starting SLIM mode (--slim-state)...
rem Dumps go to their own directory: a capture with no --slim-state carries no preparedState, so
rem mixing the two makes every later report describe the arm the server was NOT running.
call tools\laya-ctl.cmd start -Workers 2 -Threads 6 -DumpStates .preview\states-slim -SlimState -HeadMaxLen 512

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
