---
name: ui-compare
description: 最後のコミットと今の作業ツリーの画面をヘッドレス Chrome で撮り、修正前後を見比べる HTML を一時領域に作って file:// の URL を返す。/skill:ui-compare [修正内容の説明] [--base <rev>] でのみ起動。
disable-model-invocation: true
---

# ui-compare（修正前後の画面比較）

修正前＝基準コミット（既定 HEAD。`git archive` で一時ディレクトリへ展開）、修正後＝作業ツリーとして、それぞれ開発サーバーを起動して撮る。対象は Node 系の開発サーバー。スクリプトはこのスキルのディレクトリにある（`ui-compare.sh`・`capture.mjs`・`build.mjs`・`template.html`）。

## 手順

1. **`--base`**：引数にあればそれ、無ければ HEAD。HEAD と作業ツリーに差分（未追跡ファイルを含む）が無ければ、基準のコミットをユーザーに聞いて、答えを待つ（ここでターンを終える）。
2. **`--path`**：`git diff --name-only <base>` と未追跡ファイルから、ルーティングに沿って撮る URL パスを決める。直接修正したページは全部撮る。共通部品の修正で影響するページも合わせて 30 以下なら全部撮り、超えるなら絞り方をユーザーに聞いて答えを待つ。決められなければ `/` だけにして報告で伝える。
3. **`--cmd`**：`{port}` を含む起動コマンド。パッケージマネージャは lockfile に合わせ、引数の前の `--` は npm だけに付ける（例：npm＋Vite は `npm run dev -- --port {port} --strictPort`、pnpm＋Next は `pnpm run dev -p {port}`、その他は `PORT={port} pnpm run dev`）。`flake.nix` があればスクリプトが devShell 経由で動かすので `nix develop -c` は付けない。アプリがサブディレクトリなら `--dir <ルートからの相対パス>`。
4. **`--slug`**（英小文字・数字・ハイフン、30 文字以内）と **`--title`**（日本語可）を決める。
5. `bash <このスキルのディレクトリ>/ui-compare.sh --title ... --slug ... --cmd '...' --path / [...]` を実行する。bash ツールの `timeout` は付けない（ページ×幅が多いと数分かかる）。
   - **終了コード 3**：開発サーバーらしきものが複数動いている。どれを修正後に使うかユーザーに聞き、答えを待ってから、出力の案内どおり再実行する。候補のプロセスには触れない。
6. **報告**：最後に出る `file://` の URL と変化率の表（リダイレクト・既存サーバーを使った旨の行を含む）を貼る。画像は読まない。失敗したらエラーをそのまま伝え、作業ツリーを直そうとしない。

使ってよいコマンドは、`ui-compare.sh` と、読み取りの `git rev-parse`・`git diff`・`git status`・`git ls-files`・`git log` だけ。このスキルはファイルを変更する作業ではないので、PR は作らない。

## 既知の制約（該当しそうなら報告に添える）

- 修正前側には git 管理外のもの（LFS の実体・submodule・ビルド済みの `dist/` 等）が無いので、修正前側だけ欠けたりエラーになったりしうる。
- 修正後側の開発サーバーは作業ツリーで動くので、キャッシュ（`.next/` 等）を作り、`next-env.d.ts` 等を書き換えることがある（戻さない）。
- 出力は pi の一時領域（既定は `/private/tmp/pi-<uid>/<プロジェクト>/ui-compare/`。環境変数 `UI_COMPARE_OUT_DIR` で変えられる）なので再起動で消える。
- Chrome は既定で `/Applications/Google Chrome.app` を使う（環境変数 `UI_COMPARE_CHROME` で変えられる）。
