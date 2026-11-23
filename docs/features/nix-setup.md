# nix-setup スキル

## 概要

TypeScript プロジェクトの開発環境を Nix の devShell と direnv で整え、Biome・CI・Dependabot・マージ済みブランチの自動削除・Dependabot の PR へのレビュー依頼も用意する。スクリプトが決まった内容を書き出し、既存のファイルは上書きしない。

## 関連

- コード：`agent/skills/nix-setup/SKILL.md`（手順）、`scripts/setup.mjs`（本体）、`templates/`（雛形）
- テスト：`tests/nix-setup.test.ts`
- 合わせた先：Claude Code 側の nix-setup（`~/.claude/skills/nix-setup/SKILL.md`）
- 開発環境の例：[setup/development.md](../setup/development.md)（このリポジトリ自身が同じ構成）

## 使い方

`/skill:nix-setup` か「開発環境を作って」などの依頼で使う。プロジェクトを `git init` 済みにして、次を実行する。

```sh
node <スキルのディレクトリ>/scripts/setup.mjs <プロジェクトのディレクトリ> [--dry-run] [--reviewer <GitHubのログイン>]
```

- `--dry-run`：何も書かず、作るものだけを表示する
- `--reviewer`：Dependabot の PR のレビュアー。`gh api user --jq .login` の値を渡す。無ければレビュー依頼のワークフローは作らない
- ディレクトリが無い・引数の誤りは、使い方を表示して失敗する
- git 未初期化・リポジトリのルートでない・`package.json` が読めないときは、理由を表示して失敗する（何も書かない。`git init` はしない）
- create-vite などの雛形を使う新規プロジェクトは、スクリプトより先に雛形を作る（既存ファイルがあると雛形が止まるため）

## 生成するもの

- `flake.nix`（devShell。nodejs と、pnpm なら pnpm）・`.envrc`（`use flake`）
- `.gitignore`（`.direnv/`・`node_modules/` が無ければ追記。先頭・末尾の `/` の違いは同じものとみなす）
- `biome.json`・`package.json`（`lint`・`format` のうち無いキーだけ）
- `.github/workflows/ci.yml`（Nix をインストールし、`nix develop -c` で install と lint を実行。push 先は既定ブランチ。決め方は「判定のルール」）
- `.github/dependabot.yml`（github-actions と npm を毎週月曜 9:00 JST に、それぞれ 1 本の PR にまとめる。Renovate を使っていれば作らない）
- `.github/workflows/delete-merged-branch.yml`（マージ済みブランチの自動削除）
- `.github/workflows/dependabot-review-request.yml`（`--reviewer` があるとき）

## 判定のルール

- パッケージマネージャ：`pnpm-lock.yaml` なら pnpm、`package-lock.json` なら npm、どちらも無ければ pnpm。`yarn.lock`・`bun.lock` があれば変えず、CI と lint は作らない（注意を表示する）
- ESLint・Prettier の設定か依存があれば、`biome.json` と lint スクリプトは作らない（Biome への移行は提案に留める）
- `.github/workflows/` に他のワークフロー（`ci.yml`・`delete-merged-branch.yml`・`dependabot-review-request.yml` 以外）があれば、既存の CI とみなして `ci.yml` は作らない
- 処理後の `package.json` に `lint` スクリプトが無ければ（ESLint・Prettier があって足さなかった等）、`ci.yml` の lint の行をコメントにして注意を出す（初回から `Missing script: lint` で落ちないように）。`--dry-run` でも同じ判定を表示する
- CI の push 先ブランチ：`origin/HEAD` → ローカルの `main` → `master` → `git config init.defaultBranch` → `main` の順に決める。今のブランチ（作業ブランチのことがある）は使わない。選んだブランチと決め方は常に表示し、`origin/HEAD` 以外で決めたときは「違えば `ci.yml` の `branches` を直す」注意を出す
- Renovate の設定（`renovate.json`・`renovate.json5`・`.renovaterc`・`.renovaterc.json`・`.renovaterc.json5`・`.github/` か `.gitlab/` の `renovate.json`・`renovate.json5`、または `package.json` の `renovate` キー）があれば、`dependabot.yml` とレビュー依頼のワークフローは作らずスキップと注意を出す（PR の重複を避ける）
- git の判定は `git rev-parse --show-toplevel` で行う。リポジトリでなければ失敗（先に `git init`）。リポジトリのサブディレクトリを指定したら、`.github/` はルートに置くものなので失敗し、ルートのパスを示す（入れ子のリポジトリを作らせないため、`git init` はさせない。モノレポの一部に入れるのは手で行う）。比較はシンボリックリンクを解決してから行う
- `package.json` が JSON として不正（またはオブジェクトでない）なら、何かを書く前に失敗する（引数の誤りではないので使い方は出さない）

## 上書きしない

既存のファイルは触らず「スキップ」と表示する。`flake.nix` が既にあるときは、nodejs（pnpm）が無ければ手で追記するよう注意を出す。`package.json` は既存の `scripts` を変えず、無いキーだけ足す。

## そのあとの作業

スクリプトのあとにモデルが行う（SKILL.md に手順がある）。

1. `git add flake.nix .envrc` → `nix flake lock` → `git add flake.lock` → `nix develop -c node --version`
2. Biome を入れる（`nix develop -c pnpm add -D --save-exact @biomejs/biome`。npm なら `npm install -D --save-exact`）
3. `lint` が通るまでコードを直す（ルールの無効化・除外で通さない）
4. `.envrc` を確認して `direnv allow`
5. プロジェクトの AGENTS.md に検証コマンドを書く
6. `nix run nixpkgs#actionlint` でワークフローを確認する

## Claude Code 側に合わせた理由

移植元（取り込み元リポジトリ）の nix-setup は、npm・`quality.yml`・ブランチ保護の手順を前提にしていた。ユーザーの決定で、Claude Code 側の nix-setup の決まり（pnpm が既定・`ci.yml`・Dependabot のまとめ方・自動削除・レビュー依頼）に合わせた。ブランチ保護は作らない（[決定 007](../decisions/007-no-auto-branch-protection.md)）。

## 既知の制約

- TypeScript 以外（Python・C# など）は、何を用意するかユーザーに聞く
- Mac 上の実機で生成物を動かす確認（`nix develop`・`direnv allow`）は、スクリプトのテストには含まない（テストは生成物の中身と判定を確かめる）。2026-11-23 に一時ディレクトリで手動で確かめた：`nix flake lock`・`nix develop -c node --version`・`nix develop -c pnpm --version`・生成したワークフローの actionlint が通った
