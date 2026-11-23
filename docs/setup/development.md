# 開発環境

## 概要

型チェック・lint・テストを通すための開発環境。ツールは Nix の devShell に宣言し、CI も同じ devShell で同じコマンドを実行する。

## 関連

- コード：`flake.nix`・`.envrc`・`package.json`・`tsconfig.json`・`biome.json`・`tests/`
- CI：`.github/workflows/ci.yml`・`.github/dependabot.yml`・`.github/workflows/delete-merged-branch.yml`・`.github/workflows/dependabot-review-request.yml`
- 計画：[plan/phase-0-foundation.md](../plan/phase-0-foundation.md)

## devShell と direnv

- `flake.nix` の devShell に Node 22（`nodejs_22`）を宣言している。対応は `aarch64-darwin`（手元）と `x86_64-linux`（CI）
- `.envrc`（`use flake`）で、ディレクトリに入ると devShell が自動で有効になる。初回は内容を確認して `direnv allow`
- direnv が効かない環境（Claude の Bash など）では `nix develop -c <コマンド>` で実行する
- 依存は `nix develop -c npm install --ignore-scripts` で入れる。`package-lock.json` を使い、版は固定する

## `npm run check`

`biome check . && tsc --noEmit && node --test 'tests/**/*.test.ts'` を順に実行する。

- biome：lint と整形の確認。`docs` と `*.md` は対象外。直せるものは `npm run format`（`biome check --write .`）
- tsc：型チェック（strict・`noUncheckedIndexedAccess`・NodeNext）
- テスト：Node 組み込みのテストランナー

## テストの置き場所

テストは `tests/` に集める（`tests/harness-usage.test.ts`・`tests/harness-*.test.ts`）。拡張の純粋ロジック（`parse.ts`・`guards/*.ts`・`lib/*.ts` など）を `../agent/extensions/<名前>/` から import する。

## CI

`.github/workflows/ci.yml`。main への push と PR で、Nix をインストールし、`nix develop -c npm ci --ignore-scripts` と `nix develop -c npm run check` を実行する。

## Dependabot

`.github/dependabot.yml`。github-actions と npm を毎週月曜 9:00（Asia/Tokyo）に確認し、それぞれ 1 本の PR にまとめる。

pi 本体（`@earendil-works/*`）は対象外にして、手動で上げる。更新が速く、拡張が依存する API が変わりうるため。

## ブランチの自動削除

`.github/workflows/delete-merged-branch.yml`。同一リポジトリの PR がマージされたら、そのブランチを削除する（デフォルトブランチは除く）。

## Dependabot の PR へのレビュー依頼

`.github/workflows/dependabot-review-request.yml`。Dependabot が PR を開いたら、リポジトリの所有者をレビュアーに指定する。
