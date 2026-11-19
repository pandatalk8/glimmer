#!/bin/sh
# 把当前代码版本写入项目根目录的 build.json（已被 git 忽略），供插件显示“当前加载的版本”。
# 由 git 钩子在提交、合并、切换分支后自动调用；也可以手动执行：sh scripts/write_build_info.sh
root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
commit=$(git -C "$root" log -1 --format=%h 2>/dev/null) || exit 0
time=$(git -C "$root" log -1 --format=%cI)
branch=$(git -C "$root" rev-parse --abbrev-ref HEAD)
cat > "$root/build.json" <<EOF
{"commit": "$commit", "time": "$time", "branch": "$branch"}
EOF
