#!/usr/bin/env bash
# Smoke test for a running BlueprintIQ container, exercised the way a reverse proxy would:
# a production Host header and an X-Forwarded-For header.
#   deploy/smoke.sh <base-url> <public-host> <sample.pdf>
set -u
base="$1"; host="$2"; pdf="$3"
fail=0
check() { # name expected actual
  if [ "$2" = "$3" ]; then echo "ok   $1 ($3)"; else echo "FAIL $1: expected $2, got $3"; fail=1; fi
}
status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

check "health"            200 "$(status "$base/api/health")"
check "home page"         200 "$(status -H "Host: $host" "$base/")"
check "sample basic served" 200 "$(status "$base/samples/blueprintiq-sample-basic.pdf")"
check "sample cad served"   200 "$(status "$base/samples/blueprintiq-sample-cad.pdf")"
check "about page"          200 "$(status -H "Host: $host" "$base/about")"
check "diagnostics hidden" 404 "$(status "$base/pdfjs-check")"
check "viewer check hidden" 404 "$(status "$base/viewer-check")"

headers="$(curl -s -D - -o /dev/null -H "Host: $host" "$base/")"
for name in content-security-policy x-content-type-options x-frame-options referrer-policy; do
  if echo "$headers" | grep -qi "^$name:"; then echo "ok   header $name"; else echo "FAIL missing header $name"; fail=1; fi
done

upload() { curl -s -o /dev/null -w '%{http_code}' -H "Host: $1" -H "X-Forwarded-For: $2" \
  -H "Content-Type: application/pdf" --data-binary @"$3" "$base/api/inspections"; }

check "upload, listed host"   200 "$(upload "$host" 198.51.100.10 "$pdf")"
check "upload, unknown host"  403 "$(upload attacker.example 198.51.100.10 "$pdf")"
check "upload, foreign origin" 403 "$(status -H "Host: $host" -H "Origin: https://attacker.example" \
  -H "Content-Type: application/pdf" --data-binary @"$pdf" "$base/api/inspections")"

tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
echo "not a pdf" > "$tmp"
check "upload, not a PDF"     415 "$(upload "$host" 198.51.100.11 "$tmp")"
head -c 11000000 /dev/zero > "$tmp"
check "upload, over 10 MiB"   413 "$(upload "$host" 198.51.100.12 "$tmp")"

last=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do last="$(upload "$host" 198.51.100.13 "$pdf")"; [ "$last" = 429 ] && break; done
check "rate limit reached"    429 "$last"

exit $fail
