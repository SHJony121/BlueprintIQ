#!/usr/bin/env bash
# Print the current digests of the base images named in the Dockerfile, as ARG lines to paste in.
# Review the change, rebuild, and run container-ci before keeping it: a pinned digest does not
# receive base-image security updates until this is run again.
set -eu
for image in node:24-bookworm-slim python:3.12-slim-bookworm; do
  repo=${image%%:*}; tag=${image##*:}
  token=$(curl -s "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/$repo:pull" \
    | python3 -c "import sys, json; print(json.load(sys.stdin)['token'])")
  digest=$(curl -sI -H "Authorization: Bearer $token" \
    -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json' \
    "https://registry-1.docker.io/v2/library/$repo/manifests/$tag" | tr -d '\r' | awk -F': ' 'tolower($1)=="docker-content-digest" {print $2}')
  echo "$image@$digest"
done
