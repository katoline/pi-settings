# pi-settings

Pi coding agent の個人設定と拡張を置くリポジトリ。このファイルはこのリポジトリで作業するときの指示で、`CLAUDE.md` はこのファイルへのシンボリックリンク（Claude Code と Pi の両方が同じ内容を読む）。

## 構成

`agent/` は Pi のエージェントディレクトリ `~/.pi/agent` と同じ構成にし、中身を `~/.pi/agent` 配下へシンボリックリンクして使う。Pi の設定ファイル・拡張はここに置き、置き場所は Pi のドキュメントのエージェントディレクトリの規約に合わせる。

- `agent/AGENTS.md`：Pi のグローバル指示（`~/.pi/agent/AGENTS.md` から参照）。全ディレクトリでの Pi の作業に効く。このリポジトリ固有の内容は書かず、本ファイルに書く
- `agent/extensions/<名前>/index.ts`：Pi 拡張（`~/.pi/agent/extensions/<名前>` から参照すると自動で読み込まれる）。追加・削除したら `package.json` の `pi.extensions` と README を合わせる

## 検証

```sh
node --test 'agent/extensions/**/*.test.ts'
```
