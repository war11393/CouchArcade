@echo off
REM TypeScript strict-mode typecheck for the Cocos project.
REM
REM Primary path: standalone Node.js (C:\Program Files\nodejs) + TypeScript bundled
REM inside the Cocos Creator editor (5.8.2). No npm install required.
REM
REM Fallback: if Node.js is absent, run the same compiler through the editor's
REM Electron binary in Node mode (ELECTRON_RUN_AS_NODE).

setlocal
set NODE_EXE=C:\Program Files\nodejs\node.exe
set CC="C:\ProgramData\cocos\editors\Creator\3.8.8\CocosCreator.exe"
set TSC="C:\ProgramData\cocos\editors\Creator\3.8.8\resources\app.asar.unpacked\node_modules\typescript\lib\tsc.js"
set DECL=C:\ProgramData\cocos\editors\Creator\3.8.8\resources\resources\3d\engine\bin\.declarations

cd /d "%~dp0"

if not exist ".typecheck" mkdir ".typecheck"
echo /// ^<reference path="%DECL%\cc.d.ts" /^> > ".typecheck\cc-shim.d.ts"

if exist "%NODE_EXE%" (
    "%NODE_EXE%" %TSC% --noEmit -p tsconfig.check.json
) else (
    set ELECTRON_RUN_AS_NODE=1
    %CC% %TSC% --noEmit -p tsconfig.check.json
)

set CODE=%ERRORLEVEL%
echo.
echo TYPECHECK_EXIT=%CODE%
exit /b %CODE%
