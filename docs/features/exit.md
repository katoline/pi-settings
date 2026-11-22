# /exit

## 概要

組み込みの `/quit` と同じ終了処理を `/exit` でも呼べるようにする。

## 関連

- コード：`agent/extensions/exit/index.ts`

## 挙動と処理

- `pi.registerCommand("exit")` で登録し、`ctx.shutdown()` を呼ぶ
- エージェントの実行中は、終わってから終了する（pi の `shutdown` の挙動）
