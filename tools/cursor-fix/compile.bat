@echo off
REM compile.bat - one-shot helper build helper for N.E.K.O cursor stutter fix
REM
REM Builds neko_cursor_helper.exe from ./neko_cursor_helper.c with MSVC 2022 BuildTools.
REM Output: <this-directory>\neko_cursor_helper.exe (used by patch-app-asar.js --helper)
REM
REM Why "%~dp0" instead of an absolute path:
REM   The previous version hardcoded the author's unpack dir, which broke on
REM   every other user's machine. %~dp0 always resolves to this script's
REM   directory regardless of where the user invokes it from, which keeps
REM   the build reproducible.
REM
REM Why we capture cl's exit code before running dir:
REM   dir succeeds even when cl fails (because it finds the .c / .obj the build
REM   produced). Capturing %ERRORLEVEL% explicitly into a local var ensures we
REM   exit with the compiler's real status, not dir's success.

setlocal
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if errorlevel 1 (
  echo VCVARS_FAILED errorlevel=%errorlevel%
  exit /b 1
)

REM Switch to the directory containing this script + source file
pushd "%~dp0"
if errorlevel 1 (
  echo CD_FAILED errorlevel=%errorlevel%
  exit /b 1
)

echo === cwd ===
cd
echo === cl ===
where cl
echo === compile ===
REM cl exit code captured first; dir would otherwise clobber %ERRORLEVEL%
cl /nologo /O2 /W4 neko_cursor_helper.c user32.lib /Fe:neko_cursor_helper.exe /Fo:neko_cursor_helper.obj
set "CL_EXIT=%ERRORLEVEL%"
echo === cl exit %CL_EXIT% ===
dir neko_cursor_helper.*
popd
exit /b %CL_EXIT%
