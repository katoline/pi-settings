# 計画・自律ループ・検証・独立レビュー・完了報告

## 概要

ファイルを変更する依頼を、完了条件つきの計画（チェックリスト）にしてユーザーが確定し、確定後は質問せずに完了まで進める仕組み（フェーズ 4）。「完了」はモデルの申告ではなく、検証とレビューの記録で判定する。計画の状態はセッションに保存し、未完了の間はハーネスが続きを促す（自律ループ）。拡張 `harness` の `flow/` が、メインエージェントにだけ登録する（サブエージェントには登録しない）。

## 関連

- コード：`agent/extensions/harness/flow/`（`plan.ts`・`loop.ts`・`verify.ts`・`review.ts`・`report.ts`・`fingerprint.ts`・`register.ts`）、`subagent/run.ts`（`harness_review` と `subagent` が共有する子の起動）、`output/register.ts`（完了の合図の条件）、`lib/config.ts`（`flow` の上限）
- テスト：`tests/harness-plan.test.ts`・`tests/harness-flow.test.ts`（`registerFlow` のハンドラ・ツール・`/plan` を偽の `pi`・`ctx` で呼ぶ。完了報告の出し直し・差し戻しの数え方・一時停止・エラーでの終了・完了の合図とのつながり）・`tests/harness-verify.test.ts`・`tests/harness-config.test.ts`・`tests/harness-output.test.ts`・`tests/harness-subagent.test.ts`（件数・費用の数え直し）、`tests/harness-e2e-flow.test.ts`（偽のモデルで実際の pi を起動する。仕組みは `tests/harness-e2e-helpers.ts`）
- 決定：[006](../decisions/006-plan-confirm-dialog.md)（確定ダイアログは残す）、[003](../decisions/003-auto-pr-and-merge-policy.md)（PR とマージ）、[011](../decisions/011-no-worktree.md)（worktree を使わない）
- 計画：[plan/phase-4-plan-loop-verify-review.md](../plan/phase-4-plan-loop-verify-review.md)（完了）、[plan/phase-5-pr-tools.md](../plan/phase-5-pr-tools.md)（完了。PR の記録を足した）、[harness-pr.md](harness-pr.md)（PR のツール）
- 指示：[harness-instructions.md](harness-instructions.md)（`main.md` の「作業の進め方（PDCA）」「独立レビュー」）、サブエージェント：[harness-models-subagents.md](harness-models-subagents.md)
- 設定：[setup/settings.md](../setup/settings.md)（`flow` の上限）

## ツールとコマンド

| 名前 | 内容 |
| --- | --- |
| `ask_user` | 計画の段階で、要件・完了条件・判断の基準・仕様の選択をユーザーに質問する（選択肢つきは `select`、なければ `input`）。UI が無ければ断り、妥当な既定で進めて `plan_note` に記録するよう返す。**計画が確定したら `setActiveTools` でツール一覧から外し**（ツール一覧の出し入れは `flow/tools.ts` の `syncActiveTools` 1 か所で組み立て、`harness_pr_merge` の出し入れと消し合わない）、計画が完了したとき・一時停止したとき・計画が無いとき（`/plan clear` を含む）に戻す（`session_start`・`session_tree` で状態から決め直す）。一時停止中は自律で進めていないとみなす |
| `plan_propose` | 目的と、完了条件つきの項目（`id`・`title`・`acceptance`・`kind`（`change` / `task`。既定 `change`）・`review`）を提出する。空の目的・項目・重複 `id`・完了条件なしは受け付けない。ダイアログ（`ctx.ui.select`）で「確定する / 修正を依頼する / 中止する」を選ばせる（決定 006）。確定すると状態を保存する。確定済みで未完了の計画（一時停止中を含む）があるときは、確認の本文に「確定すると、未完了の計画「目的」（未着手・進行中 N 件）を置き換えます」と書く。UI が無いときは確認できず、確定しない |
| `plan_update` | 項目を `in_progress`（着手時に付ける。差し戻しは進行中の項目に数える）・`done`（`evidence` 必須）・`deferred`（`reason` 必須。ユーザーにしかできないことと、自分の変更と関係ない既存の失敗で検証が通らない項目）にする。保留の項目を `in_progress` に戻すと、報告済みの印（`reported`）を戻す。`done` は「完了のゲート」を満たすときだけ通る。完了・未完了として確定した項目は変えられない |
| `plan_note` | 計画で決めていない判断を、妥当な既定で進めたときに記録する（完了報告の「自分で判断したこと」） |
| `plan_status` | チェックリストの現在の状況 |
| `plan_report` | すべての項目が済んだら、状態から完了報告を組み立てて返す。呼ぶと、計画に報告済み（`reported: true`）を保存し、その依頼の中では「計画の完了」（`rt.planCompleted`）になって完了の合図の条件を満たす。項目が残っていれば断る |
| `harness_verify` | プロジェクトの検証コマンドを実行して記録する（「検証コマンドの探し方」） |
| `harness_review` | 差分と要件を reviewer に渡し、判定を記録する |
| `/plan` | 計画の状況を表示する。`/plan resume` で一時停止を解いて再開（続きを促すメッセージで新しい実行を始める）、`/plan stop` で一時停止、`/plan clear` で計画を破棄する（破棄を保存するので、再開・ツリーの移動でも戻らない。`ask_user` を戻し、依頼の開始時の状態の差し込みもやめる） |

ステータス行（`setStatus`）に「計画 完了数/項目数」と、実行中（▶）・一時停止（⏸）・完了（✔）を出す。

## 完了のゲート

`plan_update` で `done` にできるのは、次をすべて満たすときだけ（`updateItem`）。

1. 計画が確定している
2. 根拠（`evidence`。`file:line` やコマンドの出力）がある
3. `kind` が `change` の項目は、直近の `harness_verify` が成功している（「未検証」の記録も成功として扱うが、完了報告に「未検証」と書かれる）
4. `review: true` の項目は、直近の `harness_review` が承認されている
5. 3・4 の記録のときの作業ツリーの指紋が、今の指紋と一致する（記録のあとに変更があれば、やり直し）

作業ツリーの指紋は、`git ls-files --cached --others --exclude-standard` の全ファイルのパスと内容の SHA-256 を、パス順に重ねたハッシュ。コミットの有無に関係なく、ファイルの内容だけで決まる。git のリポジトリの外では常に同じ値になり、変更の検出はできない。

差し戻し：検証の失敗（中断でないもの）・レビューの却下（`<disapproved/>`）だけを数える。中断した検証・判定を得られなかったレビュー（マーカーなし・子の失敗・中断・時間切れ）は記録するが、数えない（承認にもしない）。数える先は、そのとき進行中（`in_progress`）の項目。進行中の項目が無ければ、次に取り組む項目（`nextItem`。先頭の未着手）に数える。回数は項目ごとの**累計**（連続でなくてもよい）で、`maxCyclesPerItem`（既定 3）回に達した項目は、止まらずに自動で「未完了」にして他の項目を進める（理由は完了報告に載る）。

## 自律ループ

`agent_before_settle` で、確定した計画に未着手・進行中の項目がある間、継続を要求する。ユーザーには見せないカスタムメッセージ（`harness-continue`）で、チェックリスト・次の項目・進め方を渡す。すべての項目が済み、まだ報告していない（計画の `reported` が無い）ときは、1 回だけ完了報告を促す（`harness-complete`）。促しを無視されても、同じ計画で繰り返さない（拡張を読み込み直したあとは、未報告なら 1 回だけ促す）。報告済みの計画では、次の依頼（「ありがとう」など）や、再開・フォーク・`/tree` のあとの依頼でも促さない。

継続しない（止まる）条件。上限に達したときは計画を一時停止にして通知する（`/plan resume` で再開。再開すると、継続の回数・経過時間の起点・無進捗の数を戻すので、上限で止めた計画がすぐ止まり直すことはない）。

| 条件 | 内容 |
| --- | --- |
| 完了 | 未着手・進行中の項目が無い |
| Esc | `agent_settled` の `aborted` が true のとき、計画を一時停止にする |
| エラーで終了 | `agent_before_settle` の `outcome` が `"error"`（pi の `AgentActivityOutcome` は `"completed"`・`"aborted"`・`"error"`）のとき、継続を要求せず、未完了の計画を一時停止（理由「エラーで終了」）にして通知する。完了の促しも出さない |
| キルスイッチ | `<エージェントディレクトリ>/harness-off`（既定 `~/.pi/agent/harness-off`）というファイルがある間は継続しない。自律中（未完了で一時停止していない）の計画は、`agent_before_settle` で一時停止（理由「キルスイッチ」）にして通知する。これで `ask_user` と完了の合図が戻る。ファイルを消して `/plan resume` で再開する |
| 継続の回数 | `flow.maxContinuations`（既定 200 回） |
| 経過時間 | 計画の確定から `flow.maxMinutes`（既定 240 分） |
| 進捗なし | 項目の状態・差し戻し回数・PR の件数・直近の成功した検証の作業ツリーの指紋が、継続のたびに同じまま `flow.maxNoProgress`（既定 3 回）続いた。検証・レビューの記録の件数は見ない（中断・失敗した検証を繰り返すだけでは進捗にならない）。大きな 1 項目を進行中のまま、編集して検証を通し直している間は、成功した検証の指紋が変わるので進捗とみなす |
| 一時停止 | `/plan stop`・Esc・エラーでの終了・キルスイッチ・上限で止めた計画 |

## 検証コマンドの探し方

`harness_verify` は、git のルート（無ければ作業ディレクトリ）で、次の順に探す。

1. `.harness/verify.json` の `{ "commands": ["npm run check"] }`（あれば最優先。書かれたコマンドをそのまま実行する。壊れていれば「見つからない」）
2. `package.json` の `check` スクリプト（これだけ実行する）
3. `lint`・`typecheck`・`type-check`・`test`・`build` のうち、あるものをこの順に

devShell：`.harness/verify.json` が無く、ルートに `flake.nix` があり、それが git で追跡されていて（`git ls-files --error-unmatch flake.nix` が成功する。git の外では包まない）、`nix` が PATH にある（`PATH` のどれかのディレクトリに `nix` がある）ときは、2・3 で見つけたコマンドを `nix develop -c <コマンド>` で実行する（エージェントのシェルでは direnv が効かないため）。判定は `flow/verify.ts` の `useDevShell`・`resolveVerifyCommands`。追跡されていない `flake.nix` で包まないのは、git の中の flake が未追跡のファイルを読まないため（作った直後に検証すると必ず失敗し、差し戻しに数えられてしまう）。

プロジェクトの `AGENTS.md` / `CLAUDE.md` に書かれた検証コマンドが、この探し方で見つかるものと違うときは、そのコマンドを `.harness/verify.json` に書いてから `harness_verify` を実行するよう、`main.md` で指示している。

実行は `bash` ツール（`ctx.executeTool`）で行うので、ガードが効く。パッケージマネージャはロックファイル（`pnpm-lock.yaml`・`yarn.lock`・`bun.lock`）で決め、無ければ `npm`。見つからなければ「未検証」として記録し、完了報告に「未検証」と書く。失敗した検証は差し戻しに数える。中断（`signal.aborted`）は失敗として記録（完了報告に「中断」）するが、差し戻しには数えない。

自分の変更と関係ない既存の失敗で検証が通らない項目は、直さずに、`plan_update` の `deferred`（失敗の内容を理由に）で保留にし、完了報告の「ユーザーへの依頼」にまとめる（`main.md` の「自律実行のルール」「変更後の検証」）。

## レビューの判定

`harness_review` は、`origin/HEAD` の指す先（無ければ `origin/main`）との merge-base（無ければ `HEAD`）に対する `git diff` と、未追跡ファイル（先頭 50 件・各 20KB まで）を差分にして、**差分と要件だけ**（計画の完了条件。`requirements` で上書きできる）を reviewer に渡す。差分は 200KB で切る。前回が却下なら、前回の指摘を渡し、直した差分だけを対象にさせる。「前回」は、判定なし（`undetermined`）を飛ばした直近の「判定あり」のレビュー（却下のあとに判定なしが挟まっても、指摘を渡す。承認のあとは渡さない）。

reviewer は、`subagent` ツールと同じ仕組み（`subagent/run.ts` の `runSubagentTasks`）で起動する。読み取り専用で、`agent/agents/reviewer.md` が役割の指示。**子の出力の最終行**に `<approved/>` があれば承認、`<disapproved/>` があれば却下（両方あれば却下）。最終行にマーカーが無い・子がエラー・中断・時間切れ・呼び出しの中断（`signal.aborted`）のときは、判定なし（`none`）として承認としない（fail-closed）。判定なしは記録（完了報告に「判定なし」）するが、差し戻しには数えず、それ自体を「前回の指摘」として渡さない。起動を断られた（上限超過など）ときは記録しない。本文の途中のマーカーは見ない。却下（`<disapproved/>`）だけを差し戻しに数える。採否はメインが判断し、直さない指摘は理由を添えて対象外として報告する（`main.md`）。

### 件数・費用の数え直し

`harness_review` が起動した子は、`subagent` と同じく `Runtime.subagentSpawns`・`childCost` に積み、`maxTotal` の上限にも数える。結果の `details` に `{ verdict, children: ChildResult[] }` を残し、`session_start`・`session_tree` の数え直し（`subagentTotals`）は、`subagent` の結果に加えて `harness_review` の `details.children` も足す。このため、再開・`/reload`・フォーク・ツリーの移動のあとも、レビューの分が 0 に戻らない。断られた呼び出し・差分なし・git の外で子を起動しなかったときは `details` が無く、数えない。

## 完了報告

`plan_report` が、状態から固定の形で組み立てる。「要件ごとの結果」（完了・未完了・保留と理由、根拠、差し戻し回数）、「実行した検証」（成功・失敗・未検証）、「独立レビュー」（承認・却下）、「自分で判断したこと」、「ユーザーへの依頼（保留した項目）」。検証は成功・失敗・中断・未検証、レビューは承認・却下・判定なしで書く。一時停止中ならその旨も書く。「PR」の欄は、PR の記録（`plan.prs`）があるときだけ出す。記録は `harness_pr_create`・`harness_pr_merge` が入れる（作成時に未保護などの注意があれば、PR の下に「注意」として出す）。

完了の合図（[harness-instructions.md](harness-instructions.md)）は、その依頼の中での成果物を作る操作の成功か、計画の完了（その依頼の中で `plan_report` を呼んだ）で付く。ただし、確定した計画を自律で進めている間（未着手・進行中の項目が残り、一時停止していない。継続の途中の応答）は付けない（`isAutonomous`）。一時停止中・計画なし・完了済みのときは、通常の条件（write・edit・commit などの成功）で付く。`planCompleted` は、新しいユーザーの依頼の開始と、計画の確定で戻る（報告済みかどうかは計画の `reported` が持ち、合図の条件には使わない）。

## 状態の渡し方とキャッシュの理由

- 計画の状態は `pi.appendEntry("harness-plan", plan)` でセッションに保存し、`session_start`・`session_tree` でセッションの枝の最新のエントリから戻す（`rt.plan`）。報告済み（`reported`）も計画と一緒に保存する。`/plan clear` は `null` を保存し、戻すと「計画なし」になる
- **システムプロンプトには載せない。** システムプロンプトが依頼ごとに変わると、その後ろの会話全体のプロンプトキャッシュが効かなくなる。代わりに、ユーザーの依頼で実行が始まるとき（`before_agent_start`、`messageType === "user"`）、確定済みで未完了の計画があるときだけ、戻り値の `message`（`customType: "harness-plan-state"`、`display: false`）でチェックリストを会話の末尾に足す。モデルには届くが画面には出ず、キャッシュは会話の末尾からしか変わらない。計画が無い・未確定・完了のときは何も足さない。`/plan resume` の開始メッセージと継続のメッセージには、状態が入っている
- e2e（`tests/harness-e2e-flow.test.ts`）で、2 つ目の依頼のリクエストに状態が含まれ、システムプロンプトには含まれず、依頼のあいだでシステムプロンプトが変わらないことを確かめている

## 既知の制約

- 作業ツリーの指紋は、git のリポジトリの外では常に同じ値（変更の検出ができない）。巨大なリポジトリでは、全ファイルの読み込みに時間がかかる
- 差し戻しは「そのとき進行中の項目すべて」に数える（複数の項目を同時に進行中にすると、まとめて数える）。進行中の項目が無いときは次の未着手の項目に数えるので、別の項目の失敗をその項目に数えることがある。1 項目ずつ、着手時に `in_progress` にして進めるよう指示している
- 差し戻しは累計で数える（成功を挟んでも戻らない）
- 保留した項目を後から `in_progress` に戻しても、継続の回数（`continuations`）と経過時間の起点（`startedAt`）は戻らない。計画の確定から `flow.maxMinutes` を過ぎていると、戻したあとの最初の `agent_before_settle` ですぐ一時停止する。止まった計画は `/plan resume` で起点と回数が戻るので、そこから続けられる
- `harness_review` の差分は、未追跡ファイルを先頭 50 件までしか含めない（残りは reviewer が直接読む）
- `harness_review` の子の費用・件数は、`details.children` が残る呼び出しだけ数え直せる。ツールが例外で終わった呼び出しは `details` が残らず、再開後は数えない（`subagent` と同じ）
- UI が無い実行（`--print`・JSON モード）では、`plan_propose` が確定できないので、計画の流れは使えない。対応しない（2026-11-23 にユーザーが判断。UI なしで pi を使う予定が無い。サブエージェントは UI なしで動くが、計画の流れは使わない）
- 計画の状態は、ユーザーの依頼ごとに 1 つのメッセージとしてセッションに残る（依頼の数だけ増える）。キャッシュを優先した結果で、圧縮（compaction）のときにまとめられる
- 計画の確定後に別の依頼をすると、その依頼も確定済みの計画の続きとして扱われる。止めるには `/plan stop`（一時停止。`ask_user` が戻り、完了の合図も通常の条件で付く。依頼の開始時の状態の差し込みは「一時停止中」として続く）か `/plan clear`（破棄）。新しい計画を確定すると、未完了の計画は置き換わる（確認の本文に書く）
- PR の作成・マージは専用ツール（[harness-pr.md](harness-pr.md)）。継続のメッセージにも、PR のツールの使い方（commit を先に・検証とレビューのあとに作る・マージは依頼されたときだけ）を入れている
