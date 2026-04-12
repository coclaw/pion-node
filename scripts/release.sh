#!/usr/bin/env bash
set -euo pipefail

# 发布 @coclaw/pion-node 到 npm。
# 流程：质量门禁 → 凭据检查 → dry-run → 发布 → 触发镜像同步 → 轮询确认。
#
# 用法:
#   bash scripts/release.sh               # 发布 latest
#   bash scripts/release.sh --dry-run     # 仅 dry-run，不实际发布

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PKG_NAME="@coclaw/pion-node"

DRY_RUN_ONLY=false
for arg in "$@"; do
	case "$arg" in
		--dry-run) DRY_RUN_ONLY=true ;;
	esac
done

NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org/}"
DIST_TAG="latest"

cd "$PKG_DIR"

PKG_VERSION=$(node -e "console.log(JSON.parse(require('fs').readFileSync('package.json','utf8')).version)")

echo "=== 发布 $PKG_NAME@$PKG_VERSION ($DIST_TAG) ==="

# Step 1: 基本检查
echo ""
echo "[STEP 1/5] 检查工作目录"
if [[ ! -f "package.json" ]]; then
	echo "[ERROR] 未找到 package.json" >&2
	exit 1
fi
echo "[INFO] 包名: $PKG_NAME  版本: $PKG_VERSION  tag: $DIST_TAG"
echo "[INFO] Registry: $NPM_REGISTRY"

# Step 2: 质量门禁
echo ""
echo "[STEP 2/5] pnpm verify"
pnpm verify

# Step 3: npm 凭据
echo ""
echo "[STEP 3/5] 校验 npm 凭据与连通性"
npm whoami --registry="$NPM_REGISTRY" >/dev/null
npm ping --registry="$NPM_REGISTRY" >/dev/null
echo "[INFO] 凭据有效"

# Step 4: dry-run + 发布
echo ""
echo "[STEP 4/5] dry-run 发布检查"
npm publish --dry-run --access public --registry="$NPM_REGISTRY" --tag "$DIST_TAG"

if [[ "$DRY_RUN_ONLY" == "true" ]]; then
	echo ""
	echo "[DONE] dry-run 完成，未实际发布。"
	exit 0
fi

echo ""
echo "[STEP 4/5] 发布到 npm (tag: $DIST_TAG)"
npm publish --access public --registry="$NPM_REGISTRY" --tag "$DIST_TAG"
echo "[INFO] $PKG_NAME@$PKG_VERSION 已提交到 npm (tag: $DIST_TAG)"

# 触发 npmmirror 同步
echo "[POST] 触发 npmmirror 同步..."
curl -sSf -X PUT "https://registry-direct.npmmirror.com/$PKG_NAME/sync" >/dev/null 2>&1 || \
	echo "[WARN] npmmirror 同步触发失败（不影响发布）"

# Step 5: 轮询确认
echo ""
echo "[STEP 5/5] 确认发布生效"
WAIT=1 DIST_TAG="$DIST_TAG" bash "$SCRIPT_DIR/release-check.sh" "$PKG_VERSION"

echo ""
echo "[DONE] $PKG_NAME@$PKG_VERSION 发布完成 (tag: $DIST_TAG)"
