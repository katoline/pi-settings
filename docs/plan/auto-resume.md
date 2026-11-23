# レート制限からの自動再開

## 概要

Codex・OpenCode Go の利用上限（5 時間・週など）に達して作業が止まったとき、上限が戻ったことを検知して、止まった作業を自動で再開する。今は、上限で止まった実行は「エラーで終了」として計画が一時停止し、ユーザーが上限の復活を待って `/plan resume` を打つ必要がある。

## 関連

- 状態：未着手（2026-11-23 に計画のみ作成。着手するときは下の「決めること」から）
- 自律ループ・一時停止・`/plan resume`：[features/harness-flow.md](../features/harness-flow.md)
- 利用状況の取得：[features/usage.md](../features/usage.md)
- pi の API：[reference/pi-api-notes.md](../reference/pi-api-notes.md)（`agent_before_settle`・`agent_settled`・`sendMessage`）

## 今ある部品

| 部品 | 場所 | 今の動き |
| --- | --- | --- |
| 上限の状態 | `agent/extensions/harness/usage/parse.ts` | Codex（`wham/usage` の `rate_limit`）・Go（`status === "rate-limited"`）から、窓ごとの `limited` と `resetsAt`（復活の時刻。取れないときは `null`）を出す |
| 取得の周期 | `agent/extensions/harness/usage/register.ts` | 60 秒ごとに取得し、フッターに出す。状態は `registerUsage` の中に閉じていて、他の部品からは読めない |
| エラー時の一時停止 | `agent/extensions/harness/flow/register.ts`（`agent_before_settle`） | `outcome === "error"` なら、自律中の計画を一時停止（理由「エラーで終了」）にする。エラーの種類は見分けていない |
| 再開 | 同上（`/plan resume`） | `resumePlan` で回数・起点を戻し、`harness-continue` のメッセージを `triggerTurn: true` で送る |
| pi 本体のリトライ | `settings.json` の `retry.*` | 一時的な失敗を最大 `retry.maxAgentDelayMs`（既定 60 秒）まで待って再試行する。5 時間・週の上限の復活までは待てない |

## 設計案

1. **検知**：`agent_before_settle` で `outcome === "error"` のとき、最後の assistant メッセージのエラー（429・`usage limit`・`rate limit` などの文言）と、今のモデルのプロバイダーの利用状況の `limited` から、上限によるエラーかを判定する。上限なら一時停止の理由を「レート制限」にして、他のエラーと分ける。判定は純粋関数に分けてテストする
2. **待機**：`resetsAt` が分かればその時刻（＋少しの余裕）まで待つ。分からなければ、利用状況を数分おきに取り直し、`limited` が外れるのを待つ。ステータス行に「⏸ 制限待ち 再開まで 1h23m」のように出す。利用状況の状態を `rt`（ランタイム）経由で `flow` から読めるようにする
3. **再開**：時刻になったら、`/plan resume` と同じ処理（共通の関数に切り出す）で再開する。通知を出す
4. **安全策**
   - 自動で再開するのは、理由が「レート制限」の一時停止だけ。Esc・`/plan stop`・キルスイッチ・上限（回数・時間・無進捗）で止めた計画は自動で再開しない
   - 待っている間にユーザーが入力した・`/plan resume`・`/plan stop`・`/plan clear` をしたら、待機を取り消す
   - 待機の時間に上限を付ける（例：週の上限で数日待つことになるなら自動で再開しない）
   - 自動再開の回数に上限を付ける（再開してすぐまた上限に当たる繰り返しを止める）
   - キルスイッチがある間は再開しない

## 制約

- pi が起動したままでないと待てない（拡張は pi のプロセスの中で動く）。閉じた・スリープした後の再開は対象外。必要なら launchd などから pi を起動する仕組みを別に考える
- 利用状況のエンドポイントは非公式で、形が変わると `resetsAt` が取れない。そのときは定期的な取り直しに頼る
- Anthropic API は従量課金で 5 時間・週の窓がないので、対象外（429 は pi 本体のリトライに任せる）

## 決めること

- [ ] 対象：確定した計画（自律ループ）だけにするか、計画のない会話も最後の依頼を送り直して再開するか
- [ ] 待機の上限（例：6 時間。週の上限は対象外にするか）
- [ ] 自動再開の回数の上限
- [ ] 待たずに別のプロバイダーのモデル（例：Codex → OpenCode Go）へ切り替えて続ける機能も入れるか（入れるなら別のタスクにする）
- [ ] 設定（`harness` の config の `flow` に足すか、別の節にするか）と、既定で有効にするか

## タスク

- [ ] 上限によるエラーの判定（純粋関数）と、一時停止の理由「レート制限」の追加。テスト：`tests/` に判定のケース（Codex・Go のエラー文、他のエラー、利用状況のみ）
- [ ] 利用状況の状態を `rt` 経由で共有する（`usage` はメインだけに登録している点に注意）
- [ ] 待機と自動再開（タイマー、ステータス表示、取り消しの条件、上限）。`/plan resume` の処理を共通化。テスト：偽の時計で、時刻での再開・取り消し・上限
- [ ] 設定の追加（`lib/config.ts`）とテスト
- [ ] `docs/features/harness-flow.md`・`docs/features/usage.md`・README の「できること」を更新し、方針を `docs/decisions/` に記録する

## 完了条件

- Codex または Go の上限でエラー終了したとき、計画が「レート制限」で一時停止し、ステータス行に再開までの時間が出る
- 上限の復活後、ユーザーの操作なしで計画が続きから再開する
- 上の安全策の各条件では、自動で再開しない
- `nix develop -c npm run check` が通る
