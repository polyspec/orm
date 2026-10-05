#!/bin/sh
# publish-output.sh <output> <command> [args...]
#
# 다른 실행이나 뒤의 단계가 읽는 build 출력 file <output>을 원자적으로 publish한다. 명령은 같은 directory의 임시
# file <output>.next-<pid>에 쓰고, 성공하면 rename으로 <output>을 바꾼다. 그래서 <output>을 읽는 쪽은 이전 file
# 전체나 새 file 전체만 보고, 중간에 끊긴 build가 남긴 반쪽 file을 보지 않는다. 인자 가운데 @OUT@은 임시 file의
# 경로로 바뀌고(go build -o @OUT@), @OUT@이 없으면 명령의 표준 출력이 임시 file이 된다. 실패한 명령의 임시 file은
# 지우고 <output>은 그대로 둔다.
set -eu

[ $# -ge 2 ] || { echo "usage: publish-output.sh <output> <command> [args...]; name the output first, then the command that writes it" >&2; exit 2; }
output=$1
shift
next="$output.next-$$"
mkdir -p "$(dirname "$output")"
trap 'rm -f "$next"' EXIT INT TERM
# @OUT@를 임시 file 경로로 바꾼 인자 목록을 만든다.
replaced=0
count=$#
i=0
while [ "$i" -lt "$count" ]; do
  argument=$1
  shift
  if [ "$argument" = @OUT@ ]; then
    set -- "$@" "$next"
    replaced=1
  else
    set -- "$@" "$argument"
  fi
  i=$((i + 1))
done
if [ "$replaced" = 1 ]; then
  "$@"
else
  "$@" > "$next"
fi
[ -f "$next" ] || { echo "publish-output.sh: $* wrote no $next; the command must write the file that @OUT@ names" >&2; exit 1; }
mv -f "$next" "$output"
trap - EXIT INT TERM
