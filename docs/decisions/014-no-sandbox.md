# 014: sandbox は作らない

- 日付: 2026-11-23
- 状態: 見送り（2026-11-23）

## 背景

ハーネスのガードは、コマンドの文字列の検査なので、`python -c` やスクリプト経由の間接実行はすり抜ける（[features/harness-guards.md](../features/harness-guards.md)）。移植元は「sandbox → ガード → ブランチ保護」の 3 段を想定していたが、sandbox は未実装だった。こちらはブランチ保護も作らない（[007](007-no-auto-branch-protection.md)）。

pi 本体（1.5.2・最新の 1.6.0 とも）には、組み込みの sandbox は無い。公式のドキュメント（`docs/containerization.md`・`docs/security.md`）が、隔離の方法と、同梱の例を案内している。

## 決定

- sandbox は作らない（2026-11-23 にユーザーが判断。特に要らない）。必要になったとき、または pi 本体が sandbox を備えたときに、改めて検討する
- 再開するときの候補を、下に残す

## 候補（pi の公式ドキュメントが案内しているもの）

| 候補 | pi が動く場所 | 隔離されるもの | 認証情報 | このリポジトリでの注意 |
| --- | --- | --- | --- | --- |
| Gondolin 拡張（pi 同梱の例 `examples/extensions/gondolin`。作者は pi と同じ earendil） | ホスト | 組み込みのツール（bash・read・write など）と `!` コマンドを、QEMU のマイクロ VM で動かす。作業フォルダは VM の `/workspace` にマウントされる（書き込みはホストに反映） | pi の認証はホストに残る。ただし、コマンドはホストの環境変数を引き継ぐ | UI・ハーネスはそのまま使える。ハーネスが自分で動かすコマンド（`gh`・`git` の `pi.exec`）と、サブエージェントの子は、別途 VM に回さないと隔離されない。QEMU（Nix で入れる）と Node 23.6 以上が要る |
| Docker Sandboxes（`sbx`、Docker の管理型 sandbox。pi 用の kit がある） | sandbox の中 | pi 全体（拡張を含む） | プロキシがホストの鍵を差し替える（sandbox に本物の鍵を置かない） | `gh` の認証・`~/.pi/agent` のリンクを sandbox の中で用意し直す必要がある。Docker Desktop が要る |
| 素の Docker | コンテナの中 | pi 全体 | 環境変数などでコンテナに渡す | いちばん単純。鍵がコンテナに入る。Mac では Docker Desktop などが要る |
| NVIDIA OpenShell | ローカルかリモートの sandbox | pi 全体。ファイル・プロセス・ネットワーク・認証情報をポリシーで制御 | ポリシーで制御 | ゲートウェイの用意が要る。個人の Mac には大がかり |

公式ではないもの：pi は以前、macOS の OS 機能で bash だけを囲う例（`@anthropic-ai/sandbox-runtime` を使う `sandbox/`）を同梱していたが、削除して Gondolin とコンテナに一本化した。自前で作る場合の参考になる。

再開するなら、第一候補は Gondolin（ホストの UI とハーネスがそのまま使え、公式の例がある）、第二候補は Docker Sandboxes（pi 全体を囲え、鍵を中に置かない）。

## 理由

- 個人の Mac で、自分が依頼した作業を動かす使い方で、今はガードによる事故防止で足りると判断した
- どの候補も、QEMU や Docker の導入（Nix の設定の変更）と、ハーネスの PR まわり（`gh`）の作り直しが要り、手間が大きい

## 関連

- pi の公式ドキュメント：`docs/containerization.md`・`docs/security.md`（`node_modules/@earendil-works/pi-coding-agent/docs/`）
- 計画の一覧：[plan/README.md](../plan/README.md)
