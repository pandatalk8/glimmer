#!/bin/sh
# 安装 git 钩子：提交、合并（git merge / pull）、切换分支、rebase 后自动更新 build.json。
# 钩子装在仓库共享的 .git/hooks 中，主目录和所有 worktree 都生效。只需执行一次：sh scripts/install-hooks.sh
hooks=$(git rev-parse --git-common-dir)/hooks
mkdir -p "$hooks"
for name in post-commit post-merge post-checkout post-rewrite; do
  cat > "$hooks/$name" <<'EOF'
#!/bin/sh
# 微光翻译：更新 build.json（由 scripts/install-hooks.sh 安装）
script="$(git rev-parse --show-toplevel)/scripts/write_build_info.sh"
[ -f "$script" ] && sh "$script"
exit 0
EOF
  chmod +x "$hooks/$name"
done
sh "$(git rev-parse --show-toplevel)/scripts/write_build_info.sh"
echo "已安装钩子：post-commit post-merge post-checkout post-rewrite（$hooks）"
