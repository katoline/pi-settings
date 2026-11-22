# 009: Anthropic はセッションの使用額を表示する（残高は出さない）

- 日付: 2026-11-22
- 状態: 有効

## 背景

フッターに各プロバイダーの利用状況を出している（Codex・OpenCode Go は使用率）。Anthropic API についても見たい。

調べたこと（2026-11-22 時点）：

- 残高（残りクレジット）を取得する API は見つからない
- アカウント全体の使用額は Usage and Cost Analytics API（`/v1/organizations/analytics/cost`）で取れる
  - ただし Admin API キーが必要で、**個人の Console アカウントでは使えない**（Console で組織を作れば使える）
  - データは通常 4 時間、最大 24 時間遅れる
- pi は assistant メッセージごとに、トークン数と単価から計算した費用（`usage.cost.total`）を記録している

## 決定

- Anthropic は「この pi セッションで Anthropic のモデルに使った額」（pi の見積もりの合計）を表示する
- 残高とアカウント全体の請求額は表示しない（Console で確認する）

## 理由

- 追加の認証なしで、その場で分かる
- 個人アカウントでは Admin API が使えない

## 却下した案

- Usage and Cost Analytics API を使う案：組織の作成と Admin API キーが要り、数時間遅れる。必要になったら別の決定で足す

## 関連

- [features/usage.md](../features/usage.md)
