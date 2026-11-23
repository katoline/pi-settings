#!/usr/bin/env bash
# このリポジトリの agent/ を、pi のエージェントディレクトリ（既定 ~/.pi/agent）にシンボリックリンクで配置する。
#
#   scripts/install.sh            配置する
#   scripts/install.sh --dry-run  何も変えず、何をするかを表示する
#
# - 配置先は ${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}
# - 既に正しいリンクなら何もしない（何度実行しても同じ結果）
# - 同じ名前のファイル・ディレクトリ・別の場所へのリンクがあれば上書きせず「競合」と表示して続行し、最後に exit 1
# - auth.json などの pi が管理するファイルには触れない
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
使い方: scripts/install.sh [--dry-run]
  --dry-run  何も変えず、何をするかを表示する
USAGE
}

dry=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "不明な引数です: $arg" >&2
      usage
      exit 2
      ;;
  esac
done

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
conflicts=0

# link <名前>: $agent_dir/<名前> -> $repo/agent/<名前>
link() {
  local name="$1"
  local src="$repo/agent/$name" dest="$agent_dir/$name"
  if [[ -L "$dest" ]]; then
    if [[ "$(readlink "$dest")" == "$src" ]]; then
      echo "済み:   $dest"
      return
    fi
    echo "競合:   $dest は別の場所へのリンクです（$(readlink "$dest")）。スキップします" >&2
    conflicts=$((conflicts + 1))
    return
  fi
  if [[ -e "$dest" ]]; then
    echo "競合:   $dest が既にあります。スキップします（内容を確認して、手動で移してください）" >&2
    conflicts=$((conflicts + 1))
    return
  fi
  if [[ $dry -eq 1 ]]; then
    echo "予定:   $dest -> $src"
    return
  fi
  mkdir -p "$agent_dir"
  ln -s "$src" "$dest"
  echo "リンク: $dest -> $src"
}

link extensions
link skills
link agents
link settings.json

# AGENTS.md は廃止済み（指示は拡張 harness が渡す）。残っていると指示が二重になるので警告だけする
if [[ -e "$agent_dir/AGENTS.md" || -L "$agent_dir/AGENTS.md" ]]; then
  echo "警告:   $agent_dir/AGENTS.md は廃止済みです。拡張 harness の指示と二重になるので、手動で削除してください（このスクリプトは消しません）" >&2
fi

if [[ $conflicts -gt 0 ]]; then
  echo >&2
  echo "競合が ${conflicts} 件ありました。上の表示を確認して、対応してください。" >&2
  exit 1
fi

if [[ $dry -eq 1 ]]; then
  echo "（--dry-run のため、何も変更していません）"
else
  echo "完了。pi を起動すると拡張が読み込まれます（変更後は pi の中で /reload）。"
fi
