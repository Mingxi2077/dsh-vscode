# dsh-harness-vscode 一键构建脚本（Windows / PowerShell）
# 用法:  .\build.ps1 [-SkipTest]
# 产出:  dist\dsh-harness-vscode-<版本>.vsix
param(
  [switch]$SkipTest
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

Write-Host "==> 安装依赖 (npm install)"
npm install --no-audit --no-fund

Write-Host "==> 编译 (tsc)"
npm run compile

if (-not $SkipTest) {
  Write-Host "==> 运行单元测试 (npm test)"
  npm test
}

Write-Host "==> 打包 vsix"
if (-not (Test-Path node_modules/.bin/vsce.cmd)) {
  npm install --save-dev @vscode/vsce --no-audit --no-fund
}
npx vsce package --no-dependencies --allow-missing-repository

Write-Host "==> 移动到 dist/"
New-Item -ItemType Directory -Force -Path "dist" | Out-Null
Get-ChildItem -Path . -Filter "dsh-harness-vscode-*.vsix" -File | ForEach-Object {
  Move-Item -Force $_.FullName (Join-Path (Join-Path $root "dist") $_.Name)
  Write-Host "    已生成: dist\$($_.Name)"
}

Write-Host "==> 构建完成"
