/** ユーザーの入力がマージを依頼しているか（「マージ」「merge」を含むか） */
export function mentionsMerge(text: string): boolean {
  return /マージ|merge/i.test(text);
}

/**
 * ユーザー入力を受けたときの「マージを依頼された」状態を返す。
 * 待機中の入力は新しい依頼なので置き換え、実行中の追加入力（steer / followUp）は今の状態に足す
 */
export function nextMergeRequested(prev: boolean, text: string, duringRun: boolean): boolean {
  return duringRun ? prev || mentionsMerge(text) : mentionsMerge(text);
}
