# ハーネスの固定の指示と完了の合図

## 概要

pi への固定の指示（作業の約束事）を、`AGENTS.md`（コンテキストファイル）ではなく、拡張 `harness` がシステムプロンプトの `<harness>` セクションに差し込んで渡す（フェーズ 2）。完了の合図（最終応答の最後の 1 行「🚀作業が完了しました！」）はモデルに書かせず、拡張が書き足す。Codex・OpenCode Go・Anthropic API のどのモデルが読んでも通じる書き方にしている。

## 関連

- コード：`agent/extensions/harness/instructions/`（`main.md`・`subagent.md`・`load.ts`・`register.ts`）、`agent/extensions/harness/output/`（`final-line.ts`・`register.ts`）
- テスト：`tests/harness-instructions.test.ts`・`tests/harness-output.test.ts`・`tests/harness-e2e-subagent.test.ts`（書き込み可の子が成功したときの合図）
- 決定：[002](../decisions/002-provider-neutral-instructions.md)（プロバイダーに依存しない 1 本）、[003](../decisions/003-auto-pr-and-merge-policy.md)（PR とマージ）、[011](../decisions/011-no-worktree.md)（worktree を使わない）
- 計画：[plan/phase-2-instructions-output.md](../plan/phase-2-instructions-output.md)（完了）
- 以前は `agent/AGENTS.md` を `~/.pi/agent/AGENTS.md` からリンクしていた（決定 002 の時点の置き場所）。フェーズ 2 で廃止した（[setup/linking.md](../setup/linking.md)）
- このリポジトリで作業するときの指示はルートの `AGENTS.md`（`CLAUDE.md` はそのリンク）で、別物

## 差し込み方

- `before_agent_start` で `event.systemPromptOptions.sections.harness` に指示の本文を入れる。`sections` 全体は置き換えず、既存のセクションは残す。システムプロンプトの全体も置き換えない
- メインは `main.md`、サブエージェント（環境変数 `PI_SUBAGENT=1`、ランタイムの `isSubagent`）は `subagent.md`
- ファイルは拡張の読み込み時に 1 度だけ読む。読めなければ pi を止めず、警告を出して差し込まない
- `main.md` を編集したら、pi を開き直すか `/reload` する

## main.md の節ごとの要約

| 節 | 要点 |
| --- | --- |
| 言語 | 日本語。成果物はプロジェクトの既存ドキュメントに合わせる |
| 進め方 | 確認を求めずに検証・PR 作成まで進める。止まってよいのは、曖昧で結果が大きく変わるときと 3 周で収束しないときだけ |
| Git操作と PR | 完了して検証が通ったら `pr` スキルで PR まで作る。マージは依頼されたときだけ、聞き返さずに実行（確認はガードのダイアログ）。既定ブランチへの commit・push はしない |
| ファイル削除・プロセス停止 | 削除は作業ルートと一時領域の内側だけ。`pkill` / `killall` は使わない |
| 作業の進め方（PDCA） | 要件をチェックリストにし、検証・独立レビュー・根拠の確認を 3 周まで回す |
| 自律実行のルール | 計画にない判断は妥当な既定で進めて報告の「自分で判断したこと」に書く。ユーザーにしかできないことは保留にして最後にまとめて依頼する。無関係な既存の失敗は直さず報告する |
| 変更後の検証 | プロジェクトの検証コマンドを通す。テストの skip などで通さない |
| サブエージェント | `subagent` ツールで任せる場面（重い調査・並列にできる作業）、4 つの役割、自己完結した依頼、書き込み可の役割は 1 件ずつで同じファイルを編集させない、子は質問・commit・push・PR・マージができない、報告は自分で確かめてから完了にする |
| 独立レビュー | `pi --print --no-session --tools read,grep,find,ls` を別プロセスで起動し、差分と要件だけを渡す |
| レビューの範囲 | 脅威モデルで見る範囲を分け、再現経路のある指摘だけを出す |
| 秘密情報 | `.env`・鍵・`auth.json` を読まない・出さない・コミットしない |
| パッケージインストールの制限 | グローバル環境を勝手に変えない。ツールは devShell に宣言する |
| 要約時に残すこと | 変更ファイルと検証の有無・検証の結果・PR・決定事項と判断待ち |

「完了の合図」の節は置かない（拡張が書き足すため）。まだ無いツール（計画・`ask_user`・検証・独立レビュー・PR のツール）には触れない。フェーズ 4・5 でそのツールを入れるときに足す。`subagent` はフェーズ 3 で入れたので「サブエージェント」の節がある。独立レビューの節（`pi --print …`）はフェーズ 4 で扱う。

## subagent.md

任された作業だけを行う。独立レビュー・commit・push・PR・マージは親に任せる。質問できないので、既定で進めて「未解決点」に書く。報告は「変更ファイル／実行した検証と結果／未解決点」の形。サブエージェントを起動する仕組みは [harness-models-subagents.md](harness-models-subagents.md)。親と同じ作業ディレクトリで動き、ほかの子が同時に動くことがあるので、任された範囲のファイルだけを変更する。

## 完了の合図

`message_end` で、メインの assistant の確定メッセージの最後の 1 行を「🚀作業が完了しました！」にする。

付ける条件：その依頼の中で、成果物を作る操作が成功している。

- `write`・`edit`
- bash の `git commit`・`git push`・`gh pr create`（`git -C <dir>` 形式を含む）
- `subagent` ツールで、書き込み可の役割（[harness-models-subagents.md](harness-models-subagents.md)）の依頼が 1 件以上成功した（`isFailed` でない）。`tool_execution_end` の結果の `details`（子の結果の配列。各要素の `writable` と失敗の判定）で判定する。pi 1.5.2 は、`tool_execution_end` の `result` に `details` を含めて渡す（e2e で確認）。読み取り専用の役割だけ、失敗、上限超過などの断りでは付かない
- `tool_execution_start`（`args` がある）でツール名とコマンドを `toolCallId` ごとに控え、`tool_execution_end`（`args` が無い）の同じ `toolCallId` で `isError` でないことを確かめて判定する

リセットは、依頼の実行が始まるとき（`before_agent_start` の `messageType === "user"`）。`input` は実行中のステア・後続メッセージでもキュー投入時に発火するため、リセットには使わない。

付けない：assistant 以外のメッセージ、`stopReason` が error / aborted / toolUse、ツール呼び出しを含むメッセージ、すでに最後の行が合図のもの、サブエージェント、成果物を作る操作が無かった依頼（質問への回答など）。

## 既知の制約

- bash の判定は `git commit` などの文字列の照合。`bash -c` の中や別名のコマンドは見ない（事故防止の補助なので許容）
- 計画の完了（フェーズ 4）や PR のツール（フェーズ 5）は、そのフェーズで条件に足す
- 1 つの依頼の途中で成果物を作った後、最後の応答が単なる質問の確認でも、合図は付く
- pi の作業中に次のメッセージを後続（followUp）としてキューに入れると、その回答にも合図が付くことがある。pi 1.5.2 は後続メッセージを新しい実行として始めず、同じエージェントループの中で渡すため（`before_agent_start` が発火せず、リセットされない）。合図が余計に付くだけでメッセージは壊れないので、直さない（2026-11-23 にユーザーが判断）
