#!/usr/bin/env bash
# dsh-vscode 一键构建脚本（macOS / Linux）
# 用法:  ./build.sh [-s]     (-s 跳过测试)
# 产出:  dist/dsh-vscode-<版本>.vsix
set -euo pipefail
cd "$(dirname "$0")"

echo "==> 安装依赖 (npm install)"
npm install --no-audit --no-fund

echo "==> 编译 (tsc)"
npm run compile

if [[ "${1:-}" != "-s" ]]; then
  echo "==> 运行单元测试 (npm test)"
  npm test
fi

echo "==> 打包 vsix"
if ! command -v npx >/dev/null 2>&1; then
  npm install --save-dev @vscode/vsce --no-audit --no-fund
fi
npx vsce package --no-dependencies --allow-missing-repository

echo "==> 移动到 dist/"
mkdir -p dist
mv -f dsh-vscode-*.vsix dist/
echo "    已生成: dist/$(ls dist | grep '\.vsix$' | tail -1)"

echo "==> 构建完成"
