# 008: `settings.json` もリポジトリで管理してリンクする

- 日付: 2026-11-22
- 状態: 有効

## 背景

pi の設定（`~/.pi/agent/settings.json`）は、pi 自身も書き換える。

- モデルを切り替えたとき：`defaultProvider` / `defaultModel`（pi 1.5.2 の `agent-session.js` で確認）
- 更新後の初回起動時：`lastChangelogVersion`
- `/settings` で設定を変えたとき

## 決定

- `agent/settings.json` に置き、`~/.pi/agent/settings.json` からシンボリックリンクで参照する（2026-11-22 に移動・リンク済み）
- pi が書き換えて出た差分は、残したければコミットし、不要なら戻す

## 理由

- 設定はこのリポジトリで管理する方針（ユーザーの判断）
- pi はロックを取ってから `writeFileSync` で書き込むので、リンク先のファイルがそのまま更新され、リンクは壊れない（pi 1.5.2 の `settings-manager.js` で確認。ロックファイルはリンクの隣、`~/.pi/agent` 側にできる）

## 却下した案

- リンクせず README に手順だけ書く案：設定がリポジトリで管理できない

## 関連

- [setup/settings.md](../setup/settings.md)、[setup/linking.md](../setup/linking.md)
