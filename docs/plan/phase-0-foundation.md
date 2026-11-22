# フェーズ 0：開発の土台

## 概要

移植するコードを型チェック・lint・テストで確かめられるようにする。挙動は変えない。

## 関連

- 移植元：`package.json`・`tsconfig.json`・`biome.json`・`.github/workflows/quality.yml`・`.github/dependabot.yml`
- 状態：未着手

## タスク

- [ ] `package.json` に開発用の依存を固定版で追加する：`@earendil-works/pi-coding-agent`（1.5.2）・`typescript`・`@biomejs/biome`・`@types/node`・`typebox`。版は移植元に合わせる
- [ ] scripts：`check`（`biome check . && tsc --noEmit && node --test`）・`test`・`format`
- [ ] `engines.node` を `>=22.19.0` にする
- [ ] `tsconfig.json`（strict・NodeNext・`allowImportingTsExtensions`・`erasableSyntaxOnly`・`noEmit`）と `biome.json`（`docs` と `*.md` は対象外）を移植元から流用する
- [ ] テストを `tests/` に集める（`usage` と `git-guard` の既存テストを移す）
- [ ] 既存の拡張（`usage`・`exit`・`git-guard`）が `tsc` と biome を通るように直す
- [ ] `flake.nix` の devShell を用意する（ユーザーのグローバル指示に従い、必要なツールは devShell に宣言する。`nix-setup` で作る）
- [ ] CI（ジョブ名 `quality`。push と PR で `npm ci --ignore-scripts` と `npm run check`。actions は SHA 固定）
- [ ] Dependabot（npm と github-actions を週次。pi 本体 `@earendil-works/*` は対象外にして手動で上げる）
- [ ] ルートの `AGENTS.md` の検証コマンドを `npm run check` に変える

## 完了条件

- `npm run check` が成功する
- CI の `quality` が PR で成功する

## 注意

- 手元の Node は v26（グローバル）。devShell の Node と版をそろえるかを決める
- pi 本体の版は手動で上げる。拡張の API が変わりうるため
