@echo off
cd /d "%~dp0"
if not exist "node_modules" (
  echo Installing devDependencies...
  call npm install || exit /b 1
)
if not exist "dist\index.js" (
  echo Building TypeScript...
  call npm run build || exit /b 1
)
node dist\index.js %*
