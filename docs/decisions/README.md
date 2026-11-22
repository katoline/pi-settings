# 決定記録

## 概要

このリポジトリの方針と、その理由・却下した案を 1 決定 1 ファイルで残す。変更するときは新しい番号で足し、古い記録の状態を「置き換え済み（→ NNN）」にする。

## 一覧

| 番号 | タイトル | 状態 | 日付 |
| --- | --- | --- | --- |
| [001](001-agent-dir-mirrors-pi.md) | `agent/` を `~/.pi/agent` と同じ構成にしてリンクで使う | 有効 | 2026-11-22 |
| [002](002-provider-neutral-instructions.md) | グローバル指示はプロバイダーに依存しない 1 本にする | 有効 | 2026-11-22 |
| [003](003-auto-pr-and-merge-policy.md) | 作業ごとに PR を自動作成し、マージは依頼されたときだけ確認して行う | 有効 | 2026-11-22 |
| [004](004-port-harness.md) | pi-coding-agent-settings のハーネスを移植して取り込む | 有効 | 2026-11-22 |
| [005](005-dangerous-ops-silent-block.md) | 危ない操作は確認ダイアログを出さずに止め、必要ならユーザーが `!` で実行する | 有効 | 2026-11-22 |
| [006](006-plan-confirm-dialog.md) | 計画の確定ダイアログは残す | 有効 | 2026-11-22 |
| [007](007-no-auto-branch-protection.md) | GitHub のブランチ保護は pi に作らせない | 有効 | 2026-11-22 |
| [008](008-link-settings-json.md) | `settings.json` もリポジトリで管理してリンクする | 有効 | 2026-11-22 |
| [009](009-anthropic-usage-session-cost.md) | Anthropic はセッションの使用額を表示する（残高は出さない） | 有効 | 2026-11-22 |
| [010](010-voice-input-own-extension.md) | Mac の音声入力は自前の拡張で作る（別途、個別に進める） | 計画中 | 2026-11-22 |
| [011](011-no-worktree.md) | pi では worktree を使わない | 有効 | 2026-11-23 |

## 書式

```markdown
# NNN: タイトル

- 日付: YYYY-MM-DD
- 状態: 有効 / 計画中 / 置き換え済み（→ NNN）

## 背景
## 決定
## 理由
## 却下した案
## 関連
```
