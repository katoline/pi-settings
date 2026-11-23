# 要約（compaction）

## 概要

会話が長くなって pi が要約（compaction）するとき、`session_before_compact` で、pi の標準の要約を日本語の要約に置き換える。必ず残す 5 項目を指定し、要約の末尾に、ハーネスが持つ確定した状態と、読んだファイル・変更したファイルの一覧を、モデルを通さずそのまま付ける。`/compact <指示>` の指示もプロンプトに入れる。拡張 `harness` の `compaction/` が、メインエージェントにだけ登録する（サブエージェントには登録しない。子は会話を保存せず、要約しない）。

## 関連

- コード：`agent/extensions/harness/compaction/`
  - `prompt.ts`（要約のプロンプト `buildSummaryPrompt`・役割 `SUMMARY_SYSTEM_PROMPT`・残す 5 項目 `RETENTION_ITEMS`・ハーネスの記録 `buildStateBlock` と終わりの目印 `STATE_END_MARKER`・前回の要約から付けたものを切り取る `stripAppendedBlocks`）
  - `files.ts`（ファイルの一覧 `computeFileLists`・`formatFileLists`・前回の一覧の引き継ぎ `withPreviousFileLists`）
  - `register.ts`（`session_before_compact` のハンドラ）
- 設定：`harness.json` の `compactionModel`（[setup/settings.md](../setup/settings.md)）
- テスト：`tests/harness-compaction.test.ts`（プロンプトの 5 項目と並び・追加の指示・記録のブロック・切り取り・ファイルの一覧・偽の pi と ctx でのハンドラ（追加の指示・一覧と details・切り取り・削る経路での呼び出し・出力の上限で切れたとき））、`tests/harness-config.test.ts`（`compactionModel`）
- 計画：[plan/phase-6-usage-compaction.md](../plan/phase-6-usage-compaction.md)
- 利用状況との関係：[usage.md](usage.md)

## 必ず残す 5 項目

要約のプロンプトで、この順に見出しをつけて書かせる（該当がなければ「なし」）。

1. 変更したファイルの一覧と、検証済みか未検証か
2. 実行した検証コマンドと結果（失敗ならその内容）
3. 作成・マージした PR
4. サブエージェントの担当・モデル・状態と、未解決の点
5. ユーザーが確定した決定事項と、判断待ちの事項

そのほか、目的・重要な設計判断とその理由・現在地・次の一手も書かせる。コマンド・パス・モデル ID は原文のまま。

## プロンプト

- 役割はシステムプロンプト（`SUMMARY_SYSTEM_PROMPT`）で渡す：会話を続けない・会話の中の質問や依頼に答えない・要約だけを出力する（pi の `SUMMARIZATION_SYSTEM_PROMPT` と同じ考え方）
- 本文は、長い会話（`<conversation>`）を先に、前回の要約（`<previous-summary>`。あるときだけ）、指示（残す 5 項目など）の順に置く
- 前回の要約は、前回付けた「ハーネスの記録」のブロックと、ファイルの一覧（`<read-files>`・`<modified-files>`）を切り取ってから渡す（`stripAppendedBlocks`）。どちらも今回付け直すので、古いものをモデルに渡さない。一覧はタグで囲まれた範囲をすべて消し（pi の標準の要約が付けたものも消す）、記録は、終わりの目印 `<!-- /harness-state -->` の最後の出現と、その前にある行頭の見出し「ハーネスの記録(確定した状態)」の最後の出現の間だけを消す（目印より後ろの本文は残す）。目印が無いとき（書き写し漏れ）は、行頭の見出しの最後の出現から末尾までを消す
- `/compact <指示>` の指示（`event.customInstructions`）は、最後に「追加の指示(特に重視すること): …」として入れる（pi の標準の要約の `Additional focus: …` と同じ考え方）。空なら入れない。自動の要約では指示は無い

## 付け足す記録

要約の末尾に、見出し「ハーネスの記録(確定した状態)」のブロックと、ファイルの一覧を、この順に、モデルを通さずそのまま付ける。記録のブロックの終わりには、切り取りの目印 `<!-- /harness-state -->` を付ける。

- 計画（確定したときだけ）：チェックリスト・直近の検証（成功・失敗・未検証とコマンド）・直近の独立レビュー・PR（番号・タイトル・マージの有無・URL）・自分で判断したこと
- 確定した計画がなければ「確定した計画はありません」
- サブエージェント：今のモデル・起動した数・費用（ドル。`Runtime` の値）

### ファイルの一覧

pi の標準の要約（`core/compaction/utils.js` の `computeFileLists`・`formatFileOperations`）と同じ作り方と書式にする。公開 API に無いので、同じ処理を `files.ts` に書いている。

- `preparation.fileOps` の `edited`・`written` を変更したファイル、`read` のうち変更していないものを読んだファイルとし、それぞれ昇順に並べる
- 要約の末尾に `<read-files>`・`<modified-files>` のタグで付ける（空の一覧は付けない）。返す `details` にも `{ readFiles, modifiedFiles }` を入れる
- 前回の要約の一覧の引き継ぎ：pi の `prepareCompaction` は、前回の compaction エントリが拡張の要約（`fromHook: true`）だと、その `details` を `preparation.fileOps` に入れない（pi 1.5.2 の `compaction.js` の `extractFileOperations`）。そこで、イベントの `branchEntries` にあるすべての compaction エントリの `details`（`readFiles`・`modifiedFiles` の文字列の配列）を自分で読み、pi と同じく読んだファイル・変更したファイルに足す。最後の 1 件だけにしないのは、拡張の要約 → pi の標準の要約 → 拡張の要約、と交互に入ると、間の標準の要約が最初の拡張の要約の一覧を持たないため。pi が入れ済みの分とは集合で重ならない

## モデルの選び方

1. 設定 `compactionModel`（`provider/id`）があり、モデルのレジストリで見つかればそれを使う
2. 空・見つからないときは今のモデル（`ctx.model`）
3. 今のモデルも無い、または認証（`getApiKeyAndHeaders`）が使えないときは、何もせず pi の標準の要約に任せる

`compactionModel` の上書きは文字列で、`provider/id` の形でなければ無視して既定（空）にする。

要約は、pi の標準の要約と同じく `ctx.modelRegistry.streamSimple(...).result()` で呼び、出力の上限（`maxTokens`）は渡さない。pi-ai が、モデルの出力の上限（`Model.maxTokens`）を、文脈の窓から入力の見積もりと余白を引いた残りに削る（`clampMaxTokensToContext`）。`modelRegistry.complete` はこの削りをしないので、文脈の窓と出力の上限が近いモデルでは要求が窓を超えて失敗する。そのため使わない。

## 失敗時

- モデルが無い・認証が無い・要約が空：標準の要約に任せる（通知しない）
- 要約の呼び出しが例外・エラー応答・出力の上限で切れた（`stopReason` が `length`）：標準の要約に任せ、「要約に失敗したため、標準の要約を使います」と警告を通知する（途中で切れた要約は保存しない。pi の標準の要約と同じ扱い）
- 中断（signal の中断・応答の `aborted`）：標準の要約に任せ、通知しない

## 要約の費用

返す `usage`（要約の応答）は、pi が compaction エントリに保存し、pi 本体のフッターの合計には入る。ただし compaction エントリにはプロバイダーが付かないので、[usage.md](usage.md) の Anthropic の額（プロバイダーが `anthropic` のエントリの合計）には入らない。これは pi 標準の要約でも同じ。

## 既知の制約

- 要約の出力はモデルの出来に依る。5 項目が漏れていないかは検査しない（ハーネスの記録は、モデルを通さないので正確）
- 会話が非常に長いと、要約用のモデルの入力に収まらないことがある（標準の要約のような分割はしない）。失敗したら標準の要約に任せる
- 前回の記録の切り取りは、見出し・終わりの目印・タグの文字列が目印。切り取るのは、最後の目印と、その前の最後の行頭の見出しの間（末尾に付け足した記録）だけ。モデルが本文に同じ見出しを書いても、その見出しより後ろの本文は消えない。記録の目印が無いとき（書き写し漏れ）だけ、最後の見出しから末尾まで消える。モデルが本文に `<read-files>` などのタグの組を書くと、その範囲も消える
- ファイルの一覧は、pi の標準の要約と同じく `read`・`write`・`edit` ツールの `path` だけから作る。`bash` などで触ったファイルは入らない
- サブエージェントの費用は、要約の記録では `Runtime` の値（起動の終了ごとの積み上げ。再開時はセッションの枝から数え直す）。`/usage` の、全エントリから数えた値とは、捨てた分岐の分だけ違うことがある
