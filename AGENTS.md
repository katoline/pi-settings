# pi-settings

Pi coding agent の個人設定と拡張を置くリポジトリ。このファイルはこのリポジトリで作業するときの指示で、`CLAUDE.md` はこのファイルへのシンボリックリンク（Claude Code と Pi の両方が同じ内容を読む）。

## 構成

`agent/` は Pi のエージェントディレクトリ `~/.pi/agent` と同じ構成にし、`~/.pi/agent` 配下からシンボリックリンクで参照している（`extensions/`・`skills/`・`settings.json`）。Pi の設定ファイル・拡張・スキルはここに置き、置き場所は Pi のドキュメントのエージェントディレクトリの規約に合わせる。ここでの変更はリンク経由でそのまま手元の Pi に効く。

- `agent/extensions/harness/instructions/main.md`：Pi のグローバル指示（メイン用。サブエージェント用は `subagent.md`）。`harness` 拡張が `<harness>` セクションで差し込み、全ディレクトリでの Pi の作業に効く（`agent/AGENTS.md` は廃止）。Codex・OpenCode Go・Anthropic API のどのモデルでも通じるよう、特定のエージェント製品のツール名やモデル名を前提にしない。このリポジトリ固有の内容は書かず、本ファイルに書く
- `agent/extensions/<名前>/index.ts`：Pi 拡張（自動で読み込まれる）。追加・削除したら `package.json` の `pi.extensions` を合わせる。判定などの純粋ロジックは別ファイルに分け、`tests/*.test.ts` でテストする（テストは拡張のディレクトリではなく `tests/` に置く）。`harness` 拡張（ガード・固定の指示・完了の合図。フェーズ 3 以降で機能を足す）は `guards/`・`instructions/`・`output/`・`lib/` などのサブディレクトリに分けている
- `agent/skills/<名前>/SKILL.md`：Pi のスキル
- `agent/settings.json`：Pi のユーザー設定。Pi 自身も書き換える（モデルの切り替えなど）ので、その差分は意図したものだけコミットする
- `agent/extensions/harness/instructions/main.md`・`agent/skills/pr`・`agent/extensions/harness/guards`（ガード）は同じ運用（作業ごとに PR を自動作成し、マージは依頼されたときだけ）を支えるので、どれかを変えたら他との食い違いを確認する

## ドキュメント（docs/）

計画・決定事項・機能の仕様・設定の詳細は `docs/` にある。まず `docs/README.md` で置き場所を見て、該当するファイルだけを読む。

- `docs/plan/`：取り込み計画（フェーズごとのタスク・完了条件・状態）と音声入力の計画
- `docs/decisions/`：決定記録。方針と食い違う変更をする前に読む
- `docs/features/`：機能ごとの仕様
- `docs/setup/`：リンク・設定・認証
- `docs/reference/`：調査結果（取り込み元のリポジトリ、pi の API の要点）

更新のルール：

- 機能を追加・変更・削除したら、同じ PR で `docs/features/` の該当ファイル（無ければ新規）と README の「できること」を更新する
- 計画のタスクを進めたら、`docs/plan/` の該当フェーズのチェックと `docs/plan/README.md` の状態を更新する
- 方針を決めた・変えたら `docs/decisions/` に記録を足す（既存の記録は書き換えず、状態を「置き換え済み（→ NNN）」にする）
- リンクや設定を変えたら `docs/setup/` を更新する

## 脅威モデル

拡張はどれも自分たちだけが使う Pi の事故防止・補助の部品。外部の入力を受けるのは `usage` 拡張の API 応答のパースだけ。

## 検証

```sh
nix develop -c npm run check
```

devShell が有効（direnv で自動）なら `npm run check`。biome・`tsc --noEmit`・テストを順に実行する。詳細は `docs/setup/development.md`。
