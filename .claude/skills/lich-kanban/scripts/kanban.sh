#!/usr/bin/env bash
# Manage the "Lich Roadmap" GitHub Project (Moikapy/projects/2).
# Usage:
#   kanban.sh board                      # print the board grouped by Status
#   kanban.sh move <issue#> <status>     # set Status (adds the issue if missing)
#   kanban.sh add <issue#> [status]      # add an issue (default status: Backlog)
#   kanban.sh new <status> <title> [labels] [body-file]   # create issue + place it
#   kanban.sh audit                      # report cards whose Status disagrees with GitHub state
# Status names: Backlog, Deferred, Todo, "In Progress", "In Review", Done
set -euo pipefail

OWNER=Moikapy
REPO=Moikapy/lich
NUM=2

need() { command -v "$1" >/dev/null || { echo "missing: $1" >&2; exit 1; }; }
need gh; need jq

project_id() { gh project view "$NUM" --owner "$OWNER" --format json -q .id; }
status_field() { gh project field-list "$NUM" --owner "$OWNER" --format json | jq -c '.fields[] | select(.name=="Status")'; }
items() { gh project item-list "$NUM" --owner "$OWNER" -L 500 --format json | jq -c '[.items[] | {id, number: .content.number, type: .content.type, title: .content.title, status, labels}]'; }

option_id() {
  local want="$1"
  status_field | jq -r --arg s "$want" '.options[] | select((.name|ascii_downcase)==($s|ascii_downcase)) | .id'
}

set_status() {
  local issue="$1" status="$2" opt item field
  opt=$(option_id "$status")
  [ -n "$opt" ] || { echo "unknown status: $status (valid: $(status_field | jq -r '[.options[].name]|join(", ")'))" >&2; exit 2; }
  field=$(status_field | jq -r .id)
  # item-add is idempotent: returns the existing item if the issue is already on the board.
  item=$(gh project item-add "$NUM" --owner "$OWNER" --url "https://github.com/$REPO/issues/$issue" --format json -q .id)
  gh project item-edit --id "$item" --project-id "$(project_id)" --field-id "$field" --single-select-option-id "$opt" >/dev/null
  echo "#$issue -> $status"
}

cmd="${1:-board}"; shift || true
case "$cmd" in
  board)
    items | jq -r '
      ["Backlog","Deferred","Todo","In Progress","In Review","Done"] as $order
      | group_by(.status // "No Status")
      | sort_by(.[0].status as $s | ($order | index($s)) // 99)[]
      | "\n## \(.[0].status // "No Status") (\(length))",
        (.[] | "  #\(.number)  \(.title)  [\(.labels // [] | join(","))]")'
    ;;
  move)
    [ $# -eq 2 ] || { echo "usage: move <issue#> <status>" >&2; exit 2; }
    set_status "$1" "$2"
    ;;
  add)
    [ $# -ge 1 ] || { echo "usage: add <issue#> [status]" >&2; exit 2; }
    set_status "$1" "${2:-Backlog}"
    ;;
  new)
    [ $# -ge 2 ] || { echo "usage: new <status> <title> [labels] [body-file]" >&2; exit 2; }
    status="$1"; title="$2"; labels="${3:-}"; body="${4:-}"
    args=(--repo "$REPO" --title "$title")
    [ -n "$labels" ] && args+=(--label "$labels")
    if [ -n "$body" ]; then args+=(--body-file "$body"); else args+=(--body ""); fi
    url=$(gh issue create "${args[@]}")
    echo "$url"
    set_status "${url##*/}" "$status"
    ;;
  audit)
    board=$(items)
    open_issues=$(gh issue list --repo "$REPO" --state open -L 500 --json number,labels | jq -c '[.[] | {number, labels: [.labels[].name]}]')
    pr_linked=$(gh pr list --repo "$REPO" --state open -L 200 --json title,body,closingIssuesReferences \
      | jq -c '[.[] | ([.closingIssuesReferences[].number] + ([(.title + " " + (.body // "")) | scan("#([0-9]+)") | .[0] | tonumber])) ] | flatten | unique')
    jq -rn --argjson b "$board" --argjson o "$open_issues" --argjson p "$pr_linked" '
      ($o | map(.number)) as $open
      | ($b | map(select(.type=="Issue")) | map(.number)) as $onboard
      | ( $o[] | select(.number as $n | $onboard | index($n) | not) | "MISSING   #\(.number) is open but not on the board" ),
        ( $b[] | select(.type=="Issue") | select(.number as $n | $open | index($n) | not) | select(.status != "Done") | "CLOSED    #\(.number) is closed but Status=\(.status) (should be Done)" ),
        ( $b[] | select(.status=="Done") | select(.number as $n | $open | index($n)) | "REOPENED  #\(.number) is open but Status=Done" ),
        ( $b[] | select(.number as $n | $p | index($n)) | select(.status!="In Review" and .status!="Done") | "HAS-PR    #\(.number) has an open PR but Status=\(.status)" ),
        ( $b[] | select((.labels // []) | index("deferred")) | select(.status!="Deferred" and .status!="Done") | "LABEL     #\(.number) has label deferred but Status=\(.status)" ),
        ( $b[] | select(.status=="Deferred") | select((.labels // []) | index("deferred") | not) | "LABEL     #\(.number) Status=Deferred but lacks the deferred label" )
    ' || true
    echo "audit complete"
    ;;
  *)
    sed -n '2,9p' "$0"; exit 2 ;;
esac
