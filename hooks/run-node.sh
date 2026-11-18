#!/bin/sh
# hook のスクリプトを node で実行する。
# デスクトップアプリから起動すると PATH にシェルの設定が入らず、
# Homebrew や nvm で入れた node が見つからないことがあるので、よくある場所も探す。
# node が見つからないときは hook を止めずに終了する。

script="$1"
event="$2"

find_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  for n in \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    "$HOME/.volta/bin/node" \
    "$HOME/.local/share/mise/shims/node" \
    "$HOME/.asdf/shims/node" \
    "$HOME/.local/state/fnm_multishells/default/bin/node" \
    "$HOME/.fnm/aliases/default/bin/node" \
    "$HOME/.nodenv/shims/node"; do
    if [ -x "$n" ]; then
      echo "$n"
      return 0
    fi
  done
  # nvm は default を優先し、なければ最も新しいバージョンを使う
  nvm_dir="${NVM_DIR:-$HOME/.nvm}"
  if [ -f "$nvm_dir/alias/default" ]; then
    v=$(cat "$nvm_dir/alias/default")
    for d in "$nvm_dir"/versions/node/v"${v#v}"*; do
      if [ -x "$d/bin/node" ]; then
        echo "$d/bin/node"
        return 0
      fi
    done
  fi
  latest=$(ls -d "$nvm_dir"/versions/node/v* 2>/dev/null | sed 's#.*/v##' |
    sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)
  if [ -n "$latest" ] && [ -x "$nvm_dir/versions/node/v$latest/bin/node" ]; then
    echo "$nvm_dir/versions/node/v$latest/bin/node"
    return 0
  fi
  return 1
}

if node_bin=$(find_node); then
  exec "$node_bin" "$script"
fi

# node が見つからない。SessionStart のときだけ理由を1回伝え、ほかの hook は何もせず通す。
cat >/dev/null
if [ "$event" = "SessionStart" ]; then
  printf '%s\n' '{"systemMessage":"[ja-sunao] Node.js が見つからないため、日本語のチェックを止めています。Node.js 18 以上を入れると有効になります。"}'
fi
exit 0
