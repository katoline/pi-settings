# フェーズ 0：開発の土台

## 概要

移植するコードを型チェック・lint・テストで確かめられるようにする。挙動は変えない。

## 関連

- 移植元：`package.json`・`tsconfig.json`・`biome.json`・`.github/workflows/quality.yml`・`.github/dependabot.yml`
- 状態：完了（2026-11-22）
- 環境の説明：[setup/development.md](../setup/development.md)

## タスク

- [x] `package.json` に開発用の依存を固定版で追加する：`@earendil-works/pi-coding-agent`（1.5.2）・`typescript`・`@biomejs/biome`・`@types/node`・`typebox`。版は移植元に合わせる
- [x] scripts：`check`（`biome check . && tsc --noEmit && node --test`）・`test`・`format`
- [x] `engines.node` を `>=22.19.0` にする
- [x] `tsconfig.json`（strict・NodeNext・`allowImportingTsExtensions`・`erasableSyntaxOnly`・`noEmit`）と `biome.json`（`docs` と `*.md` は対象外）を移植元から流用する
- [x] テストを `tests/` に集める（`usage` と `git-guard` の既存テストを移す）
- [x] 既存の拡張（`usage`・`exit`・`git-guard`）が `tsc` と biome を通るように直す（`noUncheckedIndexedAccess` の型エラーを `git-guard/check.ts` で修正。`skills/ui-compare` の `.mjs` と `template.html` も biome の指摘を直した。`agent/settings.json` は biome の整形で末尾に改行が付いた）
- [x] `flake.nix` の devShell を用意する（Node 22。`.envrc` で direnv 連携、`flake.lock` も管理する）
- [x] CI（ジョブ名 `ci`。push（main）と PR で、Nix をインストールし `nix develop -c npm ci --ignore-scripts` と `nix develop -c npm run check` を実行する。actions は `@v7` `@v23` のメジャータグ指定で、SHA 固定はしていない。Dependabot が上げる）
- [x] Dependabot（npm と github-actions を毎週月曜。pi 本体 `@earendil-works/*` は対象外にして手動で上げる）。あわせて、マージ済みブランチの自動削除と、Dependabot の PR へのレビュー依頼のワークフローも追加した
- [x] ルートの `AGENTS.md` の検証コマンドを `npm run check` に変える

## 完了条件

- `npm run check` が成功する（テスト 59 件）
- CI の `ci` が PR で成功する（未確認：PR を出して確かめる）

## 注意

- devShell の Node は 22（`nodejs_22`。22.23.5 を確認）。手元のグローバルの Node（v26）とは別なので、実行は devShell 経由で行う
- pi 本体の版は手動で上げる。拡張の API が変わりうるため
