#!/bin/zsh
# メニューバーアプリ Todo.app をビルドする。
#   ./build.sh            → mac/build/Todo.app を作る
#   ./build.sh --install  → さらに ~/Applications/Todo.app に入れて起動する
set -euo pipefail
cd "$(dirname "$0")"

swift build -c release

app="build/Todo.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
cp .build/release/TodoBar "$app/Contents/MacOS/TodoBar"
cp Info.plist "$app/Contents/Info.plist"
# 自分の Mac で動かすだけなので、開発者登録なしの署名（ad-hoc）でよい
codesign --force --sign - "$app"
echo "built: $PWD/$app"

if [[ "${1:-}" == "--install" ]]; then
  dest="$HOME/Applications"
  mkdir -p "$dest"
  pkill -x TodoBar 2>/dev/null || true
  rm -rf "$dest/Todo.app"
  cp -R "$app" "$dest/"
  open "$dest/Todo.app"
  echo "installed: $dest/Todo.app"
fi
