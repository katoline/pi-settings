# 取り込み計画

## 概要

[pi-coding-agent-settings](https://github.com/katoline/pi-coding-agent-settings) のハーネス（ルールを拡張のフックとツールで強制する仕組み）を、Mac とこちらの方針に合わせて移植する。1 フェーズ 1 PR で、上から順に進める。

## 関連

- 方針：[decisions/004](../decisions/004-port-harness.md)
- 取り込み元の機能一覧：[reference/pi-coding-agent-settings.md](../reference/pi-coding-agent-settings.md)
- 取り込み元は手元に取得して読む（`gh repo clone katoline/pi-coding-agent-settings <一時ディレクトリ>`）。移植元のパスは各フェーズに書く

## 方針（要約）

- 1 つの拡張 `agent/extensions/harness/` にまとめる。`git-guard` はガードに置き換え、`usage` は統合し、`exit` は残す
- マージ：依頼されたときだけ確認ダイアログを出して行う（[003](../decisions/003-auto-pr-and-merge-policy.md)）
- 危ない操作：確認ダイアログを出さずに止める。必要ならユーザーが `!` で実行する（[005](../decisions/005-dangerous-ops-silent-block.md)）
- 計画の確定ダイアログは残す（[006](../decisions/006-plan-confirm-dialog.md)）
- ブランチ保護は作らない。未保護なら知らせるだけ（[007](../decisions/007-no-auto-branch-protection.md)）
- Mac 向けの設定：作業ルートは `dev-roots`（`~/Dev/kaishi`・`~/Dev/seino914`・`~/Dev/hobby`・`~/Dev/humanoid`）、保護するグローバル環境は `~/Dev/seino914/dotfiles`、パッケージマネージャは `brew` と `darwin-rebuild` を含める

## フェーズ

| # | ファイル | 内容 | 状態 | 依存 |
| --- | --- | --- | --- | --- |
| 0 | [phase-0-foundation.md](phase-0-foundation.md) | 開発の土台（依存・型チェック・lint・CI・テストの配置） | 完了（2026-11-22） | — |
| 1 | [phase-1-guards.md](phase-1-guards.md) | ガード（シェル解析・git・削除・インストール・秘密情報・出力の秘匿） | 完了（2026-11-23） | 0 |
| 2 | [phase-2-instructions-output.md](phase-2-instructions-output.md) | 固定の指示（`<harness>` セクション）と完了の合図 | 完了（2026-11-23） | 1 |
| 3 | [phase-3-models-subagents.md](phase-3-models-subagents.md) | モデル選択とサブエージェント | 完了（2026-11-23） | 2 |
| 4 | [phase-4-plan-loop-verify-review.md](phase-4-plan-loop-verify-review.md) | 計画・自律ループ・検証・独立レビュー・完了報告 | 完了（2026-11-23） | 3 |
| 5 | [phase-5-pr-tools.md](phase-5-pr-tools.md) | PR の作成・依頼ゲートつきマージ | 完了（2026-11-23） | 4 |
| 6 | [phase-6-usage-compaction.md](phase-6-usage-compaction.md) | 利用状況の統合と要約（compaction） | 完了（2026-11-23） | 3 |
| 7 | [phase-7-install-skills-docs.md](phase-7-install-skills-docs.md) | 配置スクリプト・nix-setup スキル・README・e2e | 完了（2026-11-23） | 5, 6 |

## フェーズ外の作業

| ファイル | 内容 | 状態 |
| --- | --- | --- |
| — | Anthropic のセッション使用額を `usage` 拡張に追加（[009](../decisions/009-anthropic-usage-session-cost.md)） | 実装済み（2026-11-22） |
| [voice-input.md](voice-input.md) | Mac の音声入力（別途、個別に進める） | 計画のみ |

## 進め方

- 実装はフェーズごとにサブエージェントに任せ、別のコンテキストで独立レビューを受けてから PR にする
- 各フェーズの終わりに、その時点で単体で動く状態にする（途中で止めても pi が壊れない）
- 実機（実際の LLM・GitHub）での確認は、フェーズ 4・5 のあとにユーザーが行う
- フェーズを終えたら、この表の状態と各フェーズのタスクのチェックを更新し、`features/` に機能の仕様を足す
