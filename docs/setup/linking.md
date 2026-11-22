# シンボリックリンク

## 概要

`agent/` は pi のエージェントディレクトリ `~/.pi/agent` と同じ構成にしてあり、`~/.pi/agent` 配下からリンクで参照する。リポジトリでの編集がそのまま手元の pi に効く。

## 関連

- 決定：[001](../decisions/001-agent-dir-mirrors-pi.md)、[008](../decisions/008-link-settings-json.md)
- スクリプト化の予定：[plan/phase-7-install-skills-docs.md](../plan/phase-7-install-skills-docs.md)

## 張っているリンク（2026-11-23 時点）

| `~/.pi/agent` 側 | リポジトリ側 | 張った日 |
| --- | --- | --- |
| `extensions` | `agent/extensions`（ディレクトリごと） | 2026-11-22 |
| `skills` | `agent/skills`（ディレクトリごと） | 2026-11-22 |
| `settings.json` | `agent/settings.json` | 2026-11-22 |

```sh
R=/Users/peipou/Dev/hobby/katoline-org/pi-settings
ln -s $R/agent/extensions ~/.pi/agent/extensions
ln -s $R/agent/skills ~/.pi/agent/skills
ln -s $R/agent/settings.json ~/.pi/agent/settings.json
```

## 廃止したリンク

- `AGENTS.md`（`agent/AGENTS.md`）：フェーズ 2 で廃止した（2026-11-23）。指示は拡張 `harness` が `<harness>` セクションで渡す（[features/harness-instructions.md](../features/harness-instructions.md)）。残っていると同じ指示が二重に入るので、削除する（リンクだけを消す。リポジトリ側のファイルは既に無い）：

```sh
rm ~/.pi/agent/AGENTS.md
```

## リンクしないもの

- `auth.json`（API キー・OAuth トークン）・`models-store.json`・`sessions/`・`install/`・`bin/`：pi が管理する。秘密情報を含むものはリポジトリに置かない

## 反映

- 編集後は pi を開き直すか `/reload` する
- 拡張は `extensions/<名前>/index.ts` が自動で読み込まれる（`*.test.ts` などは読まれない）。スキルは `skills/` 配下の `SKILL.md` を再帰的に探す

## 注意

- このリポジトリを `pi install` でパッケージとしても入れると、拡張が二重に読み込まれる。`package.json` の `pi` 欄はパッケージとして配る場合のためのもの
