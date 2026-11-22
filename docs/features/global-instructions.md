# グローバル指示

## 概要

pi のどの作業ディレクトリでも読み込まれる指示。`agent/AGENTS.md` に置き、`~/.pi/agent/AGENTS.md` からリンクしている。Codex・OpenCode Go・Anthropic API のどのモデルが読んでも通じる書き方にしている。

## 関連

- コード：`agent/AGENTS.md`
- 決定：[002](../decisions/002-provider-neutral-instructions.md)、[003](../decisions/003-auto-pr-and-merge-policy.md)
- このリポジトリで作業するときの指示はルートの `AGENTS.md`（`CLAUDE.md` はそのリンク）で、別物
- 置き換え予定：[plan/phase-2-instructions-output.md](../plan/phase-2-instructions-output.md)（拡張の `<harness>` セクションへ移す）

## 内容（節ごとの要約）

| 節 | 要点 |
| --- | --- |
| 言語 | 日本語。成果物はプロジェクトの既存ドキュメントに合わせる |
| 完了の合図 | 完了したターンの最後の 1 行を「🚀作業が完了しました！」にする |
| 進め方 | 確認を求めずに検証・PR 作成まで進める。止まってよいのは、曖昧で結果が大きく変わるときと 3 周で収束しないときだけ |
| Git操作と PR | 完了して検証が通ったら `pr` スキルで PR まで作る。マージは依頼されたときだけ、聞き返さずに実行（確認は git-guard のダイアログ）。既定ブランチへの commit・push はしない |
| 作業用worktree | 他の作業が進行中なら `git worktree add` で分ける。削除は `--force` なし |
| ファイル削除・プロセス停止 | 削除は作業ルートと一時領域の内側だけ。`pkill` / `killall` は使わない |
| 作業の進め方（PDCA） | 要件をチェックリストにし、検証・独立レビュー・根拠の確認を 3 周まで回す |
| 変更後の検証 | プロジェクトの検証コマンドを通す。テストの skip などで通さない |
| 独立レビュー | `pi --print --no-session --tools read,grep,find,ls` を別プロセスで起動し、差分と要件だけを渡す |
| レビューの範囲 | 脅威モデルで見る範囲を分け、再現経路のある指摘だけを出す |
| 秘密情報 | `.env`・鍵・`auth.json` を読まない・出さない・コミットしない |
| パッケージインストールの制限 | グローバル環境（Mac は nix-darwin、Ubuntu は home-manager）を勝手に変えない。ツールは devShell に宣言する |
| 要約時に残すこと | 変更ファイルと検証の有無・検証の結果・PR・決定事項と判断待ち |
