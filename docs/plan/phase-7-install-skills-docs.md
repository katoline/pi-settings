# フェーズ 7：配置スクリプト・nix-setup スキル・README・e2e

## 概要

手作業のリンクをスクリプトにし、付属のスキルとドキュメントを整える。実際の pi を使う通しのテストで全体を確かめる。

## 関連

- 移植元：`scripts/install.sh`、`agent/skills/nix-setup/`、`tests/{assets,e2e}.test.ts`
- 今のリンク：[setup/linking.md](../setup/linking.md)
- 状態：完了（2026-11-23）

## タスク

- [x] `scripts/install.sh`：今のリンク（`extensions/`・`skills/`・`settings.json`・`agents/`）を張る。同じ名前のファイルがあれば上書きせず失敗、`--dry-run` あり、何度実行しても同じ結果
- [x] nix-setup スキル：`flake.nix`・`.envrc`・`biome.json`・Dependabot・CI（`ci.yml`）・ブランチの自動削除・Dependabot のレビュー依頼を生成する。Mac でも動くことを確かめる。既存ファイルは上書きしない（Claude Code 側の nix-setup の決まりに合わせ、CI は `ci.yml`・パッケージマネージャは pnpm が既定。[features/nix-setup.md](../features/nix-setup.md)）
- [x] README を全面的に書き直す（できること・導入・構成）。詳細は `docs/` を参照させる
- [x] e2e：実際の pi（1.5.2）を RPC モードで起動し、偽のモデルの台本で、ガード・計画・ループ・サブエージェント・完了の合図を通しで確かめる（既存の `tests/harness-e2e-{flow,subagent}.test.ts` と、配置の e2e で満たした）
- [x] `install.sh` で張ったリンクから拡張が読み込まれ、各コマンドが登録されることをテストする

## 完了条件

- `install.sh --dry-run` と実際の配置のテストが通る
- 実機の pi で `/reload` すると、各コマンド（`/models`・`/subagent-model`・`/plan`・`/usage`・`/exit`）が出る（実際の pi での登録は `tests/harness-e2e-install.test.ts` で確認済み。実機での `/reload` はユーザーの確認待ち）
