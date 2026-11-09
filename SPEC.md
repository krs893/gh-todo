# GH Todo 第1版 仕様

個人1人用のTodoアプリ。Mac / iPhone / Windows で使う。GitHubの非公開リポジトリにある `todos.json` を同期の経路にする。サーバーなし、ビルドなし、外部ライブラリなし（Vanilla JS + ES Modules）。UIは日本語。

## ディレクトリ構成

```
gh-todo/
  app/                     # 公開リポジトリに置き、GitHub Pages で配信する中身
    index.html
    styles.css
    app.js                 # UI・状態管理・ポーリング
    github.js              # GitHub Contents API の読み書き
    sync.js                # 純粋関数（並び替え・統合・Base64）。DOM・fetch に依存しない
    sw.js                  # Service Worker
    manifest.webmanifest
    icon.svg
  widget/
    todo-widget.js         # Scriptable 用ウィジェット
  test/
    sync.test.mjs          # node --test で動く単体テスト（sync.js 対象）
  README.md                # セットアップ手順（日本語）
```

## データ形式（データ用の非公開リポジトリの todos.json）

```json
{
  "todos": [
    {
      "id": "uuid",
      "title": "レポートを進める",
      "done": false,
      "today": true,
      "due": "2026-11-12",
      "tags": ["大学"],
      "updatedAt": "2026-11-09T10:40:00.000Z"
    }
  ]
}
```

- `id`: `crypto.randomUUID()`
- `due`: `YYYY-MM-DD` か `null`。日付のみ。日付比較は端末のローカル日付で行う（`toISOString()` で日付を作らない。UTC になってずれるため）
- `today`: 「今日やる」フラグ。期限とは別
- ファイルがまだ無い（404）場合は空の `{ "todos": [] }` として扱い、初回保存で作成する

## 設定（初回起動時の設定画面、localStorage に保存）

- owner、repo、path（既定 `todos.json`）、branch（既定 `main`）、token（fine-grained PAT、Contents: Read and write）
- 設定画面はいつでも開ける。トークンはマスク表示

## 画面

### 通常モード（編集用）
- 上部: 同期状態「同期済み 10:40」「保存中…」「未送信 n件」「エラー（再試行ボタン）」、設定ボタン、モニター表示へのリンク
- 追加フォーム: タイトル（Enter で追加）、任意で期限・今日やる・タグ（カンマ区切り）
- 一覧: 未完了のみ。並び順は
  1. 期限切れ（due < 今日）
  2. 今日（today が true、または due が今日）
  3. 今後（due 昇順）
  4. 期限なし
  同じグループ内は today が true のものを先、次に due 昇順、次に updatedAt 降順
- 各項目: チェックで完了、タップで編集（タイトル・期限・今日やる・タグ）、削除
- 完了済みは折りたたみ欄に表示し、元に戻せる。「完了済みをすべて消去」ボタン
- タグで絞り込み（任意の簡単なもの）
- スマホ幅（375px）でも使いやすく。ダークモード対応（prefers-color-scheme）

### モニターモード（`index.html?mode=monitor`）
- Windows で常時表示する用。大きな文字、操作なし（閲覧専用）
- 「今日やる / 今日が期限 / 期限切れ」を上に大きく、その下に今後の数件
- 期限切れは色で区別。期限は「今日」「明日」「11/12(水)」のように表示
- 最終取得時刻を表示。最終取得から5分以上たっていたら「古い内容」と分かる表示
- 画面が見えている間（`document.visibilityState === 'visible'`）だけ45秒ごとに取得
- Screen Wake Lock API が使えれば画面のスリープを抑止（見えなくなったら解放、戻ったら再取得）

## 同期（重要）

### 状態（localStorage）
- `cache`: `{ todos, sha, lastSyncedAt }` … 最後に GitHub から取得または保存に成功した内容
- `pending`: `{ [id]: { type: "upsert", todo } | { type: "delete" } }` … まだ GitHub に送っていない変更。タスクID単位で最新の1件だけ持つ

### 表示
- 画面に出すのは `applyPending(cache.todos, pending)` の結果
- 起動時は cache を即表示し、裏で最新を取得

### 取得
- GET `https://api.github.com/repos/{owner}/{repo}/contents/{path}?ref={branch}`
- ヘッダー: `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`
- **`fetch(..., { cache: "no-store" })` を必ず指定**（ブラウザキャッシュで古い sha を掴むと 409 が続くため）。`Cache-Control` などの独自リクエストヘッダーは足さない
- 取得成功で `cache` を更新。pending はそのまま残す（表示は applyPending で重ねる）
- 通常モードでは起動時・フォーカス復帰時（visibilitychange / focus）に取得

### 保存
- 変更操作は pending に積み、**1.5秒デバウンス**してから保存
- 保存は**同時に1つだけ**（直列化）。保存中に新しい変更が来たら、終わってからもう一度保存
- 手順:
  1. `next = applyPending(cache.todos, pending)` を作る
  2. PUT（`message: "Update todos"`, `content: base64(JSON)`, `sha: cache.sha`（無ければ省略）, `branch`）
  3. 成功: `cache = { todos: next, sha: 応答の content.sha, lastSyncedAt: now }`。**送った時点の pending のうち、その後変わっていないものだけ**消す
  4. **409 または 422（sha 不一致）**: GET で最新を取り直して cache を更新し、手順1からやり直す。最大3回
  5. ネットワークエラー・401・403 など: pending を残したままエラー表示。再試行ボタン、次回起動時、online イベント時に再送
- 保存前に毎回 GET はしない（409 のときだけ取り直す）

### 統合ルール `applyPending(base, pending)`（sync.js の純粋関数）
- 最新の base（GitHub の内容）の上に、**手元でまだ送っていない変更だけ**を重ねる。一覧全体をマージしない（別端末で消したタスクが古い一覧から復活するのを防ぐため）
- upsert: 同じ id が base にあれば、`base側.updatedAt > pending側.updatedAt` のときだけ base を残し、それ以外は pending で置き換える。無ければ追加
- delete: base から同じ id を取り除く（無ければ何もしない）
- 「完了済みをすべて消去」は、完了済み各項目の delete を pending に積む

### Base64
- `btoa`/`atob` を直接文字列に使うと日本語が壊れる。`TextEncoder`/`TextDecoder` 経由で UTF-8 ⇔ Base64 を変換する関数を sync.js に置く
- GET 応答の `content` には改行が入っているので取り除いてからデコード
- JSON は `JSON.stringify(data, null, 2)` + 末尾改行（GitHub 上の差分を読みやすくする）

## Service Worker
- アプリ本体（同一オリジンのファイル）だけキャッシュ。`api.github.com` へのリクエストには一切触らない
- アプリファイルは network-first、オフライン時はキャッシュ。キャッシュ名にバージョンを付け、activate で古いキャッシュを削除
- 新しい版が来たら画面下に「更新があります（再読み込み）」を出す

## manifest
- `display: "standalone"`, 日本語の name/short_name, start_url `./`, icon.svg（`purpose: "any"`）
- iPhone 用に index.html へ `apple-mobile-web-app-capable` 等の meta と apple-touch-icon を入れる

## Scriptable ウィジェット（widget/todo-widget.js）
- 冒頭の定数: OWNER, REPO, PATH, BRANCH, APP_URL（GitHub Pages の URL）
- トークンは `Keychain` に保存（キー `gh_todo_token`）。無ければアプリ内実行時に `Alert` で入力させて保存。ウィジェットとして実行中に無ければ「Scriptableで一度実行してトークンを設定」と表示
- 取得: `Request` で GET、`Accept: application/vnd.github.raw+json` で生の JSON を受け取る（Base64 デコード不要）
- 成功したら `FileManager.local()` にキャッシュ保存。失敗したらキャッシュを表示し「取得失敗」表示
- 表示: 通常モードと同じ並び順で未完了の上位5件（small は3件）、期限ラベル、最終取得時刻
- ロック画面（`config.widgetFamily` が `accessoryRectangular` / `accessoryInline` / `accessoryCircular`）: 件数や次の1件など簡潔に
- `widget.url = APP_URL`、`widget.refreshAfterDate` は15分後
- 並び替えは sync.js と同じ規則をウィジェット内に自前で実装（Scriptable は ES Modules を import できないため）

## テスト（test/sync.test.mjs）
- `node --test` で実行。外部依存なし
- 対象: applyPending（追加・更新・削除・updatedAt 比較・別端末で削除済みのものを復活させない）、並び替え、UTF-8 Base64 往復（日本語・絵文字）、ローカル日付の今日判定

## README.md
- リポジトリを2つ作る手順（アプリ用＝公開、データ用＝非公開）
- fine-grained PAT を2つ作る手順（PWA 用 Contents: Read and write、Scriptable 用 Contents: Read-only。どちらもデータ用リポジトリだけ）
- GitHub Pages の有効化
- iPhone: Safari で開いて「ホーム画面に追加」、Scriptable の設定とウィジェット配置
- Windows: Edge/Chrome で「アプリとしてインストール」→ `?mode=monitor` を開く → PowerToys Always On Top（Win+Ctrl+T）
- 注意: トークンは端末の localStorage に保存される。共有端末では使わない

## 第1版でやらないこと
通知、繰り返しタスク、期限の時刻指定、競合時の選択画面、JSON 書き出し・読み込み、操作ログ方式の同期、schemaVersion、他人との共有
