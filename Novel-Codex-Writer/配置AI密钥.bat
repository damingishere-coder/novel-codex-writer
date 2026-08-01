@echo off
chcp 65001 >nul
setlocal
title 配置小说工作台 AI 密钥

echo.
echo ==================================================
echo   小说工作台 - 配置 DeepSeek API 密钥
echo ==================================================
echo.
echo 密钥只会保存在本机项目根目录的 .env 文件中。
echo 网页不会回显密钥，Git 也会忽略这个文件。
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$secret = Read-Host '请粘贴 DeepSeek API 密钥（输入内容会被隐藏）' -AsSecureString;" ^
  "$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret);" ^
  "try {" ^
  "  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr);" ^
  "  if ([string]::IsNullOrWhiteSpace($plain)) { throw '密钥不能为空。' }" ^
  "  $target = Join-Path '%~dp0' '.env';" ^
  "  $content = 'DEEPSEEK_API_KEY=' + $plain + [Environment]::NewLine + 'AI_MOCK_MODE=false' + [Environment]::NewLine;" ^
  "  [IO.File]::WriteAllText($target, $content, (New-Object Text.UTF8Encoding($false)));" ^
  "  Write-Host ''; Write-Host '配置成功：已写入 .env。' -ForegroundColor Green;" ^
  "  Write-Host '请先关闭网页，再重新双击“启动网页.bat”。';" ^
  "} finally { if ($ptr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) } }"

if errorlevel 1 (
  echo.
  echo 配置失败。请确认粘贴的密钥不为空，然后重试。
)

echo.
pause
endlocal
