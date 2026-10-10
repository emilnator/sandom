#!/bin/sh
# Runs the repros against a Sandom checkout, or against a pinned set on the CDN.
#
#   run.sh <sandom-checkout> [nn …]   e.g. run.sh ~/src/sandom        (every repro)
#                                          run.sh ~/src/sandom 03 07  (two of them)
#   run.sh --pinned [nn …]             the CDN set f1e14195019cce73 (sandom src and fonts), no checkout
#
# Each repro prints PASS/FAIL lines and ends with "all passed" or "<n> failed".
# Deno gets read access to the checkout and these repros only, and the network only for
# cdn.urania-libs.com (Sandom's WebAssembly, fonts and, with --pinned, its modules).
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
PIN=f1e14195019cce73
FONTS=4ac082ad6cf25238
CDN=https://cdn.urania-libs.com/set

if [ $# -lt 1 ]; then
  sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
fi

MAP=$(mktemp -t sandom-import-map.XXXXXX.json)
trap 'rm -f "$MAP"' EXIT
if [ "$1" = "--pinned" ]; then
  READ="$HERE/repros"
  cat > "$MAP" <<EOF
{
  "imports": {
    "sandom/": "$CDN/$PIN/sandom/src/",
    "https://urania.blue/urania/libs/sandom-fonts/": "$CDN/$FONTS/sandom-fonts/",
    "https://urania.blue/urania/libs/": "$CDN/$PIN/"
  }
}
EOF
else
  SANDOM=$(cd "$1" && pwd)
  [ -f "$SANDOM/src/dom/render-component.js" ] || { echo "$SANDOM is not a Sandom checkout" >&2; exit 2; }
  READ="$SANDOM,$HERE/repros"
  # The checkout imports three WebAssembly packages by bare name (package.json: @sandom/color,
  # @sandom/font-metrics, @sandom/gain-map); the pinned set's builds of them serve.
  cat > "$MAP" <<EOF
{
  "imports": {
    "sandom/": "file://$SANDOM/src/",
    "@sandom/color/color.wasm": "$CDN/$PIN/sandom-color/dist/color.wasm",
    "@sandom/font-metrics/font-metrics.wasm": "$CDN/$PIN/sandom-font-metrics/dist/font-metrics.wasm",
    "@sandom/gain-map/gain-map.wasm": "$CDN/$PIN/sandom-gain-map/dist/gain-map.wasm"
  }
}
EOF
fi
shift

FLAGS="--quiet --no-config --no-lock --unstable-raw-imports --import-map=$MAP"
FLAGS="$FLAGS --allow-import=cdn.urania-libs.com:443 --allow-net=cdn.urania-libs.com --allow-read=$READ"
# 05 runs each of its cases in a child Deno with these same flags.
export REPRO_DENO_FLAGS="$FLAGS"

if [ $# -eq 0 ]; then set -- $(cd "$HERE/repros" && ls [0-9][0-9]-*.js | cut -c1-2); fi
for number in "$@"; do
  for repro in "$HERE"/repros/"$number"-*.js; do
    echo "== $(basename "$repro")"
    extra=""
    case "$repro" in
      */05-*) extra="--allow-env=REPRO_DENO_FLAGS --allow-run=$(command -v deno)" ;;
    esac
    # wgpu's adapter probe prints this on machines with more than one GPU driver.
    deno run $FLAGS $extra "$repro" 2>&1 | grep -v "enumerate_adapters" || true
  done
done
