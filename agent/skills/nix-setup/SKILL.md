---
name: nix-setup
description: 新規・途中からの TypeScript プロジェクトの開発環境を Nix の devShell + direnv で整え、Biome・CI・Dependabot・マージ済みブランチの自動削除も用意する。「開発環境を作って」「devShell を用意して」などの依頼で使う。
---

# 開発環境セットアップ（Nix + direnv）

TypeScript プロジェクトの開発環境を、スクリプトで決まった内容を書き出して整える。Python・C# など TypeScript 以外は、何を用意するかユーザーに聞く。依頼が一部（CI だけ等）なら、その部分だけ手で行う。

## 実行方法

雛形（create-vite・create-next-app 等）を使う新規プロジェクトは、**setup.mjs より先に**雛形を作る（既存ファイルがあると雛形が止まるため）。`.git` 以外のファイルがあれば作らずユーザーに聞き、`npx`・`npm create` ではなく `nix shell nixpkgs#nodejs nixpkgs#pnpm -c pnpm create <雛形> .` で、非対話のフラグを付けて動かす。

プロジェクトで `git init` 済みにしてから、このスキルのディレクトリの `scripts/setup.mjs` を実行する。指定するのはリポジトリのルート（`.github/` を置く場所）。サブディレクトリを指定すると失敗するので、表示されたルートを指定し直す。そのサブディレクトリで `git init` はしない（入れ子のリポジトリになる）。モノレポの一部に入れる場合は、スクリプトを使わず手で行う。

```
node <このスキルのディレクトリ>/scripts/setup.mjs <プロジェクトのディレクトリ> [--dry-run] [--reviewer <GitHubのログイン>]
```

- まず `--dry-run` で作るものを確認してよい。何も書かれない
- `--reviewer` には `gh api user --jq .login` の値を渡す（Dependabot の PR にだけレビュー依頼を出すワークフローに使う。無ければそのワークフローは作られない）
- 作るもの：`flake.nix`・`.envrc`・`.gitignore`（`.direnv/`・`node_modules/` の追記）・`biome.json`・`package.json`（無いキーの `lint`・`format` だけ）・`.github/workflows/{ci,delete-merged-branch,dependabot-review-request}.yml`・`.github/dependabot.yml`
- パッケージマネージャは `pnpm-lock.yaml` なら pnpm、`package-lock.json` なら npm、どちらも無ければ pnpm。それ以外（yarn 等）は変えず、CI と lint は作らない
- 既存のファイルは上書きしない。ESLint・Prettier があれば Biome の設定は作らない。表示された「スキップ」「注意」はそのまま報告する
- 処理後の `package.json` に `lint` スクリプトが無ければ、`ci.yml` の lint の行はコメントになる（注意が出る）。`lint` を用意したら行頭の `# ` を消す
- CI の push 先ブランチは `origin/HEAD` → ローカルの `main` → `master` → `git config init.defaultBranch` → `main` の順に決まる（今のブランチは使わない）。`origin/HEAD` 以外で決まったときは注意が出るので、GitHub の既定ブランチと違えば `ci.yml` の `branches` を直す
- Renovate の設定（`renovate.json` 等や `package.json` の `renovate` キー）があれば `dependabot.yml` とレビュー依頼のワークフローは作らない
- `package.json` が JSON として読めなければ、何も書かずに失敗する。直してから再実行する

## そのあとの作業

1. `git add flake.nix .envrc`（flake は git 追跡ファイルしか読まない）→ `nix flake lock` → `git add flake.lock` → `nix develop -c node --version`
2. Biome を入れる：`nix develop -c pnpm add -D --save-exact @biomejs/biome`（npm なら `nix develop -c npm install -D --save-exact @biomejs/biome`）。入れたら `nix develop -c pnpm exec biome migrate --write` で `biome.json` の設定を合わせてよい
3. `nix develop -c pnpm run lint`（npm なら `npm run lint`）が通るまでコードを直す。ルールの無効化・除外で通さない（`lint` スクリプトが無ければ飛ばす）
4. `.envrc` の内容を確認してから `direnv allow`
5. プロジェクトの AGENTS.md に検証コマンド（`nix develop -c pnpm run lint` 等、実在するものだけ）を書く。無ければ作る
6. `nix run nixpkgs#actionlint` で `.github/workflows` を確認する

## 注意

- 既存の設定は上書きしない。flake.nix がすでにあれば、nodejs（pnpm）が無いときだけ手で追記する
- npm・yarn のプロジェクトを pnpm へ移行しない（提案に留める）
- ESLint・Prettier から Biome への移行や、全体の自動整形は提案に留める
- `brew install`・`npm install -g`・`nix profile install` 等のグローバルなインストールはしない。必要なツールは flake.nix に宣言する
- 秘密情報（`.env`・トークン）は作らない・置かない
