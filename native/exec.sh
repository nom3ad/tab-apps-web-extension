#!/bin/sh
set -e

export LC_ALL=C

if [ -n "$TABAPPS_STDERR_FILE" ]; then
    exec 2>"$TABAPPS_STDERR_FILE"
    # set -x;id >&2;pwd >&2;echo "$*" >&2;env >&2
fi

cd "$(dirname "$0")"
exec python main.py