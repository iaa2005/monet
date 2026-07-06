@echo off
REM Claude Code CLI Launcher for Windows
REM Usage: claude [options] [prompt]
REM Requires: bun (https://bun.sh)
REM Requires: ANTHROPIC_API_KEY environment variable (or use --settings)

setlocal
set "SCRIPT_DIR=%~dp0"
bun run "%SCRIPT_DIR%bin\claude.js" %*
endlocal
