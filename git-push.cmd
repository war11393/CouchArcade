@echo off
REM ============================================================
REM  git-push.cmd -- push with token fallback
REM
REM  Auth order:
REM    1) Windows Credential Manager (credential.helper=manager)
REM    2) token in .github-token  (fallback)
REM
REM  Usage:
REM    git-push.cmd            push current branch to origin
REM    git-push.cmd <branch>   push the given branch
REM ============================================================
setlocal enabledelayedexpansion

cd /d "%~dp0"

set "TOKENFILE=.github-token"
set "BRANCH=%~1"
if "%BRANCH%"=="" (
    for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD') do set "BRANCH=%%b"
)

REM ---------- step 1: try Credential Manager (no token) ----------
echo [1/2] Trying Windows Credential Manager for branch "%BRANCH%" ...
git -c credential.interactive=never push origin "%BRANCH%" >"%TEMP%\gitpush.log" 2>&1
if not errorlevel 1 goto ok_cm
echo      Credential Manager push did not succeed.
type "%TEMP%\gitpush.log"
goto trytoken

:ok_cm
echo      OK - pushed via Credential Manager
goto done

:trytoken
REM ---------- step 2: fall back to .github-token ----------
echo [2/2] Falling back to "%TOKENFILE%" ...

if not exist "%TOKENFILE%" (
    echo      FAIL - "%TOKENFILE%" not found and Credential Manager failed.
    exit /b 1
)

set "TOKEN="
for /f "usebackq tokens=1,* delims==" %%a in ("%TOKENFILE%") do (
    if not defined TOKEN (
        set "LINE=%%a"
        if not "!LINE:~0,1!"=="#" (
            if not "%%b"=="" set "TOKEN=%%b"
        )
    )
)
for /f "tokens=* delims= " %%t in ("!TOKEN!") do set "TOKEN=%%t"

if "!TOKEN!"=="" (
    echo      FAIL - no token found in "%TOKENFILE%".
    echo             Fill in GHP_TOKEN=... from https://github.com/settings/tokens
    exit /b 1
)

echo      Token loaded [!TOKEN:~0,8!...], pushing ...
for /f "delims=" %%u in ('git remote get-url origin') do set "REMOTE=%%u"
set "AUTHRT=%REMOTE:https://=https://x-access-token:!TOKEN!@%"

git push "%AUTHRT%" "%BRANCH%" >"%TEMP%\gitpush.log" 2>&1
if errorlevel 1 (
    echo      FAIL - push failed.
    type "%TEMP%\gitpush.log"
    exit /b 1
)
echo      OK - pushed via token
git config credential.helper manager
git remote set-url origin "%REMOTE%"
del "%TEMP%\gitpush.log" 2>nul

:done
echo.
echo Remote head:
git ls-remote --heads origin 1>&2
if errorlevel 1 echo      (could not read remote - network hiccup?)
endlocal
