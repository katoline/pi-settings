# シンボリックリンク

## 概要

`agent/` は pi のエージェントディレクトリ `~/.pi/agent` と同じ構成にしてあり、`~/.pi/agent` 配下からリンクで参照する。リポジトリでの編集がそのまま手元の pi に効く。

## 関連

- 決定：[001](../decisions/001-agent-dir-mirrors-pi.md)、[008](../decisions/008-link-settings-json.md)
- 配置スクリプト：`scripts/install.sh`（[plan/phase-7-install-skills-docs.md](../plan/phase-7-install-skills-docs.md)）
- テスト：`tests/install.test.ts`・`tests/harness-e2e-install.test.ts`

## 張っているリンク（2026-11-23 時点）

| `~/.pi/agent` 側 | リポジトリ側 | 張った日 |
| --- | --- | --- |
| `extensions` | `agent/extensions`（ディレクトリごと） | 2026-11-22 |
| `skills` | `agent/skills`（ディレクトリごと） | 2026-11-22 |
| `settings.json` | `agent/settings.json` | 2026-11-22 |
| `agents` | `agent/agents`（ディレクトリごと。サブエージェントの役割の定義） | 2026-11-23 |

## install.sh の使い方

```sh
scripts/install.sh --dry-run   # 何も変えず、何をするかを表示する
scripts/install.sh             # 配置する
```

- 配置先は `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}`。上の 4 つのリンクを張る（無ければ配置先のディレクトリも作る）
- 冪等：既に正しいリンクなら「済み」と表示して何もしない。何度実行しても同じ結果になる
- 競合：同じ名前のファイル・ディレクトリ・別の場所へのリンクがあれば、上書きせず「競合」と表示してその 1 件を飛ばし、残りは続けて、最後に exit 1 で終わる。内容を確認して、手で移してから再実行する
- 引数が不明なら、使い方を表示して exit 2
- `AGENTS.md` が残っていれば警告だけする（下の「廃止したリンク」）

## 廃止したリンク

- `AGENTS.md`（`agent/AGENTS.md`）：フェーズ 2 で廃止した（2026-11-23）。指示は拡張 `harness` が `<harness>` セクションで渡す（[features/harness-instructions.md](../features/harness-instructions.md)）。残っていると同じ指示が二重に入るので、削除する（リンクだけを消す。リポジトリ側のファイルは既に無い）。`install.sh` は残っていれば警告するが、消さない：

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
