#!/bin/sh
# 从私有仓库导出开源仓库：去掉内部文档的全部历史、作者邮箱改为 GitHub noreply 地址，并做发布前检查。
# 私有仓库本身不会被修改。
#
# 用法：scripts/export_public.sh <目标目录> [分支，默认 dev]
#   导出后检查无误，再推送到新建的公开仓库：
#   cd <目标目录> && git remote add origin git@github.com:<owner>/<repo>.git && git push -u origin master --tags
#
# 需要 git-filter-repo（brew install git-filter-repo）；推荐再装 gitleaks 做全量历史扫描（brew install gitleaks）。
set -eu

DEST="${1:?用法：scripts/export_public.sh <目标目录> [分支]}"
BRANCH="${2:-dev}"
# 公开历史中作者与提交者使用的邮箱（GitHub → Settings → Emails 中的 noreply 地址）
PUBLIC_EMAIL="${PUBLIC_EMAIL:-163845883+pandatalk8@users.noreply.github.com}"
PUBLIC_NAME="${PUBLIC_NAME:-Mr Panda}"
SRC="$(git rev-parse --show-toplevel)"

[ -e "$DEST" ] && { echo "目标目录已存在：$DEST" >&2; exit 1; }
git clone --quiet --no-local --single-branch --branch "$BRANCH" "$SRC" "$DEST"
cd "$DEST"
git remote remove origin

# 内部文档：现在的 docs/internal/ 与它们搬家前的旧路径
git filter-repo --force --quiet --invert-paths \
  --path docs/internal \
  --path docs/release-plan.md --path docs/launch-plan.md --path docs/project-context.md \
  --path docs/regression --path docs/idea \
  --path-glob 'docs/review_*' \
  --path tests/env.example

# 作者与提交者：AI 助手的署名保留，其余统一为公开身份
git filter-repo --force --quiet \
  --email-callback "return email if email.endswith(b'@anthropic.com') else b'$PUBLIC_EMAIL'" \
  --name-callback "return name if name.startswith(b'Claude') else b'$PUBLIC_NAME'"

git branch -m "$BRANCH" master 2>/dev/null || true

echo "== 发布前检查 =="
fail=0
if git log --all --format='%ae%n%ce' | sort -u | grep -v -e "^$PUBLIC_EMAIL\$" -e '@anthropic.com$' ; then
  echo "✗ 历史中仍有其他邮箱（见上）"; fail=1
else
  echo "✓ 作者 / 提交者邮箱只有公开身份与 AI 助手"
fi
if git log --all --name-only --format= | grep -E '^docs/(internal/|release-plan|launch-plan|project-context|regression/|idea/|review_)' | sort -u | head -5 | grep . ; then
  echo "✗ 历史中仍有内部文档（见上）"; fail=1
else
  echo "✓ 历史中没有内部文档"
fi
if git log --all -p | grep -nE 'sk_(test|live)_[A-Za-z0-9]{20,}|rk_(test|live)_[A-Za-z0-9]{20,}|whsec_[A-Za-z0-9]{20,}|sb_secret_[A-Za-z0-9_-]{20,}|GOCSPX-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{30,}|\bsk-[A-Za-z0-9_-]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY' | head -5 | grep . ; then
  echo "✗ 历史中疑似有密钥（见上）"; fail=1
else
  echo "✓ 历史中没有常见格式的密钥"
fi
if command -v gitleaks >/dev/null 2>&1; then
  gitleaks git --no-banner --redact . && echo "✓ gitleaks 全量历史扫描通过" || fail=1
else
  echo "! 未安装 gitleaks，发布前请安装后再运行一次（brew install gitleaks）"
fi
echo "提交数：$(git rev-list --count HEAD)；导出位置：$DEST"
exit $fail
