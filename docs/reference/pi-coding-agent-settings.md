# 取り込み元：pi-coding-agent-settings の機能一覧

## 概要

[katoline/pi-coding-agent-settings](https://github.com/katoline/pi-coding-agent-settings)（2026-11-22 時点、`cd76460`）で実装されている内容。ソースと設計ドキュメント（`docs/decisions/001〜012`）を読んでまとめた。パスは取り込み元のリポジトリからの相対で、`H/` は `agent/extensions/harness/` の略。

## 関連

- 取り込み計画：[plan/README.md](../plan/README.md)
- こちらとの方針の違い：[decisions/004](../decisions/004-port-harness.md)

## 基本方針と前提

- ルールは `AGENTS.md`（コンテキスト）ではなくハーネス（拡張のフックとツール）で強制する。コンテキストのルールは守られ方がぶれ、仕組みなら毎回同じ動きになるため
- 3 層：止める（`tool_call` のガード、fail-closed）・流れに組み込む（`agent_before_settle` の自律ループ）・固定の指示を渡す（`<harness>` セクション）
- 防御の層は sandbox → ガード → GitHub のブランチ保護。sandbox は未実装（第一候補 Gondolin、第二候補 Docker）。ガードは文字列の検査なので `python -c` などはすり抜ける
- 環境：Ubuntu のデスクトップ PC。MacBook から Tailscale で TUI を使う。pi は npm グローバルで 1.5.2 に固定し手動で更新
- 実機（実際の LLM・GitHub・使用率の取得）は未検証

## 1. ガード（`H/guards/`、`H/lib/`）

**共通**

- bash と file 系ツール（read・write・edit・grep・find・ls）を実行前に判定。結果は拒否・許可制（`ctx.ui.confirm`。UI が無ければ拒否）・許可
- 例外時は拒否（fail-closed）。pi はフックが例外を投げるとツールを実行してしまうため
- シェルの字句解析器を自作（`H/lib/shell.ts`、約 620 行）：`sh -c`・`$( )`・`eval` の中を再帰解析、`env`・`timeout`・`nohup`・`xargs` などのラッパーを剥がす、変数で組み立てた語は判定不能として拒否、解析できない構文は拒否。パスはシンボリックリンクを解決して判定
- write / edit：既定ブランチ上でのリポジトリ内の編集と `.git` の中への書き込みを拒否
- 設定：`H/config.default.json` に `~/.pi/agent/harness.json` を重ねる

**Git（`H/guards/git.ts`）**

- 拒否：既定ブランチへの commit・push・merge、force 系 push、`--no-verify`、`--mirror` / `--all` / `--prune`、マージ済みでないリモートブランチの削除、自分が作っていない worktree の削除、bash からの `gh pr create` / `gh pr merge`（専用ツールへ誘導）、`gh api` の書き込み、`gh secret` / `ruleset` / `auth` / `repo delete` など。サブエージェントからの commit・push・merge・rebase・tag・worktree・PR の書き込み
- 許可制：`--amend`・`reset --hard`・`clean`・`checkout -- .`・`restore`・`branch -D`・`stash drop`・`rebase`・`filter-repo`・`reflog expire`・`gc --prune` など

**削除・プロセス（`H/guards/fs.ts`・`paths.ts`）**

- 削除（`rm`・`find -delete`・`rsync --delete` など）は作業ルート（ルート自身は除く）と一時領域の内側だけ。変数で組み立てたパス・`cd` と同じコマンド列・`xargs` 経由は拒否
- `pkill` / `killall` / `fuser -k` は拒否。`kill` は PID（2 以上）と `$(lsof -ti :ポート)` だけ

**インストール（`H/guards/install.ts`）**

- `sudo` / `doas` / `su` は拒否（実行してほしいコマンドをユーザーに示させる）
- 許可制：`apt` / `brew` / `dnf` など、`npm -g`、`pip --user`、`pipx`、`uv tool`、`cargo` / `go` / `gem install`、`nix profile`、`nix-env`、`home-manager switch`、`nixos-rebuild`、`curl | sh`
- 保護パス（既定：`~/Dev/kaishi/ubuntu-dotfiles`・`~/.pi/agent`）への書き込みは許可制。作業ディレクトリがその内側なら許可

**秘密情報（`H/guards/secrets.ts`）**

- 拒否：`.env`・鍵・`auth.json`・`~/.ssh`・`~/.aws`・`~/.config/gh/hosts.yml` などの読み取り・出力（`.env.example` などは可）、`env` / `printenv` / `export -p` などの環境変数の一覧、`echo $..KEY..`
- 出力の秘匿（`tool_result`）：秘密鍵・`sk-ant-`・`sk-`・`ghp_`・`AKIA`・Slack・JWT・Bearer・URL 内のパスワード・`token=…` などを `[秘匿]` に置換

## 2. 計画と自律ループ（`H/flow/`）

- ツール：`ask_user`（計画中の質問）、`plan_propose`（チェックリストを出し「確定 / 修正 / 中止」を選ばせる）、`plan_update`・`plan_note`・`plan_status`・`plan_report`、コマンド `/plan`（`resume` / `stop`）
- 計画を確定すると `ask_user` をツール一覧から外す（質問しないことを仕組みで守らせる）
- 項目の状態：未着手・進行中・完了・未完了・保留。完了にできるのは、根拠があり、変更を伴う項目は検証が成功し、レビュー必須の項目は承認済みで、そのときの作業ツリーの指紋（`git ls-files` の全ファイルのパスと内容のハッシュ）が今と一致するときだけ
- 検証の失敗・レビューの却下が 3 回で、その項目を自動で「未完了」にして他を進める
- 自律ループ：`agent_before_settle` で継続させる（画面に出ないメッセージ）。止まる条件は完了・Esc・キルスイッチ（`~/.pi/agent/harness-off`）・継続 200 回・240 分・進捗なし 3 回。上限は固定
- 状態は `appendEntry` でセッションに保存し、毎回システムプロンプトに載せる
- 完了報告（`plan_report`）は状態から自動生成：要件ごとの結果・検証・レビュー・PR・自分で判断したこと・ユーザーへの依頼

## 3. 検証と独立レビュー（`H/flow/verify.ts`・`review.ts`）

- `harness_verify`：`.harness/verify.json` → `package.json` の `check` → `lint`・`typecheck`・`test`・`build` の順に探して実行（bash ツール経由なのでガードと秘匿も効く）。無ければ「未検証」（自動マージされない）
- `harness_review`：サブエージェントの reviewer（読み取り専用）に、`merge-base` からの差分・未追跡ファイル・要件だけを渡す。最終行の `<approved/>` / `<disapproved/>` で判定し、無ければ承認としない。2 回目以降は修正した差分だけ

## 4. Git・GitHub の専用ツール（`H/flow/git-tools.ts`・`pr.ts`）

- `harness_worktree`：作成と削除。削除は自分が作ったものだけで、変更や未 push のコミットがあれば残す
- `harness_ensure_protection`：既定ブランチがルールセットで保護されているか確かめ、無ければ確認ダイアログのうえで作る（PR 必須・force push と削除の禁止・必須チェック `quality`・バイパス不可）
- `harness_pr_create`：push して PR を作成・更新（確認なし）。本文は「概要・変更点・確認方法」の固定の形
- `harness_pr_merge`：CI 成功・検証が最新・レビュー承認・未着手の項目なしのゲートを満たせば、確認なしで merge commit でマージしてリモートブランチを削除

## 5. サブエージェント（`H/subagent/`、`agent/agents/`）

- `subagent` ツール：別の `pi` プロセス（`--mode json -p --no-session --no-extensions -e <harness>`）。1 回 8 件・同時 4 件・1 件 15 分・合計 64 件
- 表示：「⏳ サブエージェント（モデル）で…を実行中」「✅ …が完了」。使用量と費用を集計
- 役割：scout（調査）・planner（計画）・reviewer（レビュー）は読み取り専用、worker（実装）は書き込み可
- 既定モデルは OpenCode Go の DeepSeek V4.1 Flash（`/subagent-model` で切替）。子は `PI_SUBAGENT=1` で見分けてガードを厳しくする

## 6. 固定の指示（`H/instructions/`）

- `before_agent_start` でシステムプロンプトの `<harness>` セクションに差し込む。メインは `main.md`、子は `subagent.md`
- 内容：言語、PDCA と各ツールの使い方、自律実行のルール（計画外の判断は既定で進めて記録、ユーザーにしかできないことは最後にまとめて依頼）、サブエージェントへの任せ方、レビューの範囲

## 7. モデル選択（`H/models/`、`agent/settings.json`）

- 起動時と `/models` で、OpenCode Go・Anthropic API（Opus 5.5・Sonnet 5.5・Fable 5.2・Haiku 5.5）・Codex から選ぶ
- `enabledModels` で使えるモデルを絞る

## 8. 利用状況（`H/usage/`）

- Anthropic：このセッションの使用額（サブエージェント分を含む）。Go：5 時間・週・月の使用率。Codex：5 時間・週の使用率
- 取得失敗は表示が変わるだけで作業は止めない

## 9. 要約（`H/compaction/`）

- `session_before_compact` で日本語の要約に置き換え、5 項目を必ず残す。末尾にハーネスの記録をそのまま付ける

## 10. 完了の合図（`H/output/`）

- `message_end` で、成果物を作る操作をしたか計画が完了したときの最終応答に「## ✅ 作業完了」を書き足す

## 11. スキル・配置・CI・テスト

- nix-setup スキル：`flake.nix`・`.envrc`・`biome.json`・Dependabot・CI（`quality`）を生成。既存ファイルは上書きしない
- `scripts/install.sh`：`~/.pi/agent` にリンクで配置。同名ファイルがあれば失敗、`--dry-run` あり
- CI：`biome check`・`tsc --noEmit`・`node --test`。Dependabot は pi 本体を対象外
- テスト：純粋関数のユニットテストと、実際の pi を RPC モードで起動し偽のモデルの台本で通しを確かめる e2e

## 設計ドキュメントの決定記録（要約）

| 番号 | 内容 |
| --- | --- |
| 001 | ハーネスは pi |
| 002 | プロバイダーは OpenCode Go・Anthropic API・Codex の 3 系統 |
| 003 | 人が TUI で対話する使い方が主軸 |
| 004 | OS は Ubuntu（NixOS は使わない。Ubuntu 上の Nix は使う） |
| 005 | 音声入力は接続元で使い分け（Linux は拡張、Mac 経由は Aqua Voice） |
| 006 | ブランチ保護を前提にし、Anthropic は使用額を表示、使用率の非公式エンドポイント依存は許容、sandbox を入れる |
| 007 | pi は npm グローバルで導入し版を固定（暫定） |
| 008 | sandbox は公式のもの（Gondolin、次点 Docker）。未実装 |
| 009 | サブエージェントの方式は保留（別プロセス方式を暫定） |
| 010・011 | 旧設計を捨てて作り直す。PR の作成とマージは確認なしで進めてよい |
| 012 | v1 の実装記録。マージは merge commit、上限値、ブランチ保護の内容 |
