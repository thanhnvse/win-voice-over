@echo off
REM Double-click to start the VieNeu-TTS server behind the extension's VieNeu engine.
REM It runs in this window: close the window or press Ctrl+C to stop it.
REM VieNeu-TTS is looked for in this folder; set VIENEU_DIR to use another checkout.
REM No labels or goto here: cmd.exe misreads those in a file with LF line endings.
setlocal
if not defined VIENEU_DIR set "VIENEU_DIR=%~dp0VieNeu-TTS"
set "PYTHON=%VIENEU_DIR%\.venv\Scripts\python.exe"
if not exist "%PYTHON%" (
    echo No VieNeu-TTS virtualenv at %VIENEU_DIR%\.venv -- see the VieNeu section of README.md.
    pause
    exit /b 1
)
REM -f: an HTTP error is a failure too, so only a real VieNeu counts as running.
curl.exe -sf -m 2 -o NUL http://127.0.0.1:8000/health
if not errorlevel 1 (
    echo VieNeu is already running on 127.0.0.1:8000. Nothing to do.
    pause
    exit /b 0
)
echo Starting VieNeu on 127.0.0.1:8000. Loading the model takes a little while;
echo the first start also downloads it.
echo Keep this window open while you watch. Close it or press Ctrl+C to stop VieNeu.
echo.
cd /d "%VIENEU_DIR%"
REM Loopback only, whatever the environment says: the API has no key.
set "HOST=127.0.0.1"
set "PORT=8000"
"%PYTHON%" -m apps.openai_speech
REM Reached only when the server stops by itself; keep its last words readable.
echo.
echo VieNeu stopped. See the messages above.
pause
