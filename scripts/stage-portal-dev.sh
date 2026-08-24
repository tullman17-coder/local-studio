#!/usr/bin/env bash
set -euo pipefail
# Install staged Local Studio Dev on portal without touching production Local Studio.app
PORTAL="${PORTAL_HOST:-portal@10.250.224.32}"
SRC="${LOCAL_STUDIO_STAGED_APP:-/Users/macmini/Projects/local-studio-house-v2.15.2/frontend/dist-desktop-dev/mac-arm64/Local Studio Dev.app}"
DEST="/Applications/Local Studio Dev.app"

if [[ ! -d "$SRC" ]]; then
  echo "missing staged app: $SRC" >&2
  exit 1
fi

ssh -o ConnectTimeout=25 -o BatchMode=yes "$PORTAL" 'true'
rsync -a --delete "$SRC/" "$PORTAL:$DEST/"
ssh -o ConnectTimeout=25 -o BatchMode=yes "$PORTAL" "test -x '$DEST/Contents/MacOS/Local Studio Dev' && echo installed '$DEST'"
echo "Connect that app to http://10.250.158.81:18088 — do not replace /Applications/Local Studio.app"
