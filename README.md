# Todo セットアップ手順

GitHub の非公開リポジトリにある `todos.json` を同期経路として使う、個人1人用の Todo アプリです。Mac / iPhone / Windows でサーバーなし・ビルドなしで利用できます。

---

## 1. リポジトリを2つ作成する

GitHub Pages（無料プラン）でアプリを配信しつつ Todo データ自体は非公開に保つため、リポジトリを**アプリ用**と**データ用**の2つに分けて作成します。

### ① アプリ配信用リポジトリ（公開 / Public）
1. GitHub で新しいリポジトリ（例: `gh-todo`）を **Public** で作成します。
2. このプロジェクト一式を push します。アプリ本体は `docs/` にあり、GitHub Pages はこのフォルダを配信します。

### ② データ保存用リポジトリ（非公開 / Private）
1. GitHub で新しいリポジトリ（例: `my-todo-data`）を **Private** で作成します。
2. README 等で初期化して `main` ブランチを作っておきます（`todos.json` は初回保存時に自動作成されるため、手動で作らなくても構いません）。

---

## 2. Fine-grained Personal Access Token (PAT) を2つ作成する

GitHub の **Settings → Developer settings → Personal access tokens → Fine-grained tokens** から、用途別に2つのトークンを発行します。

### ① PWA（Webアプリ）用トークン（読み書き用）
- **Token name**: `gh-todo-pwa` など
- **Repository access**: **Only select repositories** を選び、**データ用の非公開リポジトリ（例: `my-todo-data`）だけ**を選択
- **Permissions** → **Repository permissions**:
  - **Contents**: `Read and write`
  - （Metadata は自動で `Read-only` になります。それ以外の権限は不要です）

### ② Scriptable（iPhone ウィジェット）用トークン（読み取り専用）
- **Token name**: `gh-todo-widget` など
- **Repository access**: **Only select repositories** を選び、**データ用の非公開リポジトリ（例: `my-todo-data`）だけ**を選択
- **Permissions** → **Repository permissions**:
  - **Contents**: `Read-only`

---

## 3. GitHub Pages を有効化する

1. **アプリ配信用リポジトリ（Public）** の **Settings → Pages** を開きます。
2. **Build and deployment** の **Source** で `Deploy from a branch` を選択します。
3. ブランチに `main`、フォルダに `/docs` を選んで **Save** します。
4. 数分後に `https://<owner>.github.io/<app-repo>/` で公開されます。
5. 初回アクセス時に設定画面が開くので、以下を入力して保存します。
   - **Owner**: GitHub ユーザー名
   - **Repo**: データ用の非公開リポジトリ名（例: `my-todo-data`）
   - **Path**: `todos.json`（既定）
   - **Branch**: `main`（既定）
   - **Token**: ①で作成した **PWA 用トークン（Read and write）**

---

## 4. iPhone でのセットアップ

### PWA（ホーム画面に追加）
1. iPhone の **Safari** で GitHub Pages の URL を開きます。
2. 画面下の共有ボタンから **「ホーム画面に追加」** を選びます。
3. ホーム画面のアイコンから起動し、初回設定で Owner / Repo / Token を設定します。

### Scriptable ウィジェット
1. App Store から **Scriptable** をインストールします。
2. Scriptable で新規スクリプトを作成し、`widget/todo-widget.js` の中身を貼り付けます。
3. ファイル冒頭の定数を自分の環境に合わせて書き換えます：
   ```js
   const OWNER = "your-github-username";
   const REPO = "my-todo-data";
   const PATH = "todos.json";
   const BRANCH = "main";
   const APP_URL = "https://your-github-username.github.io/gh-todo/";
   ```
4. **Scriptable アプリ内で一度スクリプトを実行**します。トークン入力ダイアログが出るので、②で作成した **Scriptable 用トークン（Read-only）** を入力して保存します（iOS の Keychain に `gh_todo_token` として安全に保存されます）。
5. iPhone のホーム画面またはロック画面を長押しして Scriptable ウィジェットを追加し、ウィジェット設定で作成したスクリプトを選択します。

ウィジェットは1分後以降の更新を要求します。実際の更新時刻は iOS が決めるため、1分ごとの更新やアプリで保存した直後の反映は保証されません（[Scriptable 公式説明](https://docs.scriptable.app/listwidget/#refreshafterdate)）。

---

## 5. Windows（常時モニター表示）でのセットアップ

1. Windows の **Microsoft Edge** または **Google Chrome** で、`https://<owner>.github.io/<app-repo>/?mode=monitor` を開きます。
2. アドレスバー右端のアイコン（またはメニューの「アプリ」→「このサイトをアプリとしてインストール」）から **アプリとしてインストール** します。
3. インストールしたウィンドウを開き、**Microsoft PowerToys** の **Always On Top** 機能（ショートカット: `Win + Ctrl + T`）を使うと、常に最前面にピン留めしてモニター表示できます。
   - モニターモードは画面が見えている間だけ45秒ごとに自動取得し、Screen Wake Lock API に対応していればスリープを抑止します。

---

## ⚠️ セキュリティ上の注意

- PWA に設定したトークンは、お使いのブラウザ・端末の `localStorage` にそのまま保存されます。
- **共有端末（ネットカフェ、大学の共用PCなど）では絶対に使用しないでください。**
- `<owner>.github.io` 配下のプロジェクトサイトはすべて同じオリジンを共有するため、同じアカウントで公開している他のページのスクリプトからもこの `localStorage` は読めます。信頼できないコードを同じアカウントの Pages で公開しないでください（トークンの権限をデータ用リポジトリだけに絞っているのはこのためです）。
- ウィジェットが「取得失敗」と出る場合、`todos.json` がまだ無いか、トークンの権限・リポジトリ名が間違っています（GitHub は権限がないときも 404 を返します）。
- 万が一トークンが漏洩した場合は、GitHub の Fine-grained tokens 設定画面から該当トークンを即座に Revoke（失効）してください。

---

## 単体テストの実行方法

Node.js（v18以降）で以下のコマンドを実行すると、`docs/sync.js` の単体テストが走ります。

```bash
node --test
```
