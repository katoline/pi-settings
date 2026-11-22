# 004: pi-coding-agent-settings のハーネスを移植して取り込む

- 日付: 2026-11-22
- 状態: 有効

## 背景

[katoline/pi-coding-agent-settings](https://github.com/katoline/pi-coding-agent-settings) は、ルールを `AGENTS.md`（コンテキスト）ではなく拡張のフックとツール（ハーネス）で強制している。コンテキストに書いたルールは守られ方が毎回ぶれ、仕組みで強制すれば毎回同じ動きになるため。こちらは `AGENTS.md` の指示と小さなガード（`git-guard`）が中心で、同じことを実現したい。

## 決定

- 取り込み元のコードを移植し、Mac とこちらの方針に合わせて直す。一から書き直さない
- 1 つの拡張 `agent/extensions/harness/` にまとめる。`git-guard` はハーネスのガードに置き換え、`usage` は統合する。`exit` は残す
- フェーズに分け、1 フェーズ 1 PR で進める（[plan/README.md](../plan/README.md)）
- こちらの方針との違いは次の決定に従う：マージ（[003](003-auto-pr-and-merge-policy.md)）、危ない操作（[005](005-dangerous-ops-silent-block.md)）、計画の確定（[006](006-plan-confirm-dialog.md)）、ブランチ保護（[007](007-no-auto-branch-protection.md)）

## 理由

- 取り込み元は pi 1.5.2 向けで、こちらも 1.5.2。拡張の API がそのまま使える
- 取り込み元にはユニットテストと、実際の pi を使う e2e テストがあり、移植の確認に使える

## 却下した案

- 一から書き直す案：作業量が大きい
- 取り込み元をそのまま入れる案：Ubuntu 前提（作業ルート・保護パス・apt）で、マージと確認ダイアログの方針がこちらと逆

## 取り込まないもの

- sandbox（取り込み元でも未実装）
- 取り込み元の音声入力の方針（Linux 前提）。Mac の音声入力は [010](010-voice-input-own-extension.md)
- `dropContextFiles`（プロジェクトの `AGENTS.md` を読ませない設定）

## 関連

- 取り込み元の機能一覧：[reference/pi-coding-agent-settings.md](../reference/pi-coding-agent-settings.md)
