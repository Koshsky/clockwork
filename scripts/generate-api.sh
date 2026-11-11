#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
mode=${1:---check}
case "$mode" in --check|--write) ;; *) echo 'Usage: generate-api.sh [--check|--write]' >&2; exit 2 ;; esac
output=$(mktemp -d)
container=
cleanup() {
  [ -z "$container" ] || docker rm -f "$container" >/dev/null
  rm -rf "$output"
}
trap cleanup EXIT HUP INT TERM
container=$(docker create -v "$root/backend/docs/swagger:/spec:ro" \
  openapitools/openapi-generator-cli:v7.24.0 generate \
  -i /spec/swagger.yaml -g typescript-axios -o /output \
  --global-property apiDocs=false,modelDocs=false,apiTests=false,modelTests=false)
docker start -a "$container"
docker cp "$container:/output/." "$output"
python3 - "$mode" "$output" "$root/frontend/src/api" <<'PY'
from pathlib import Path
import re,sys,shutil
mode,generated,target=sys.argv[1],Path(sys.argv[2]),Path(sys.argv[3])
def normalized(text):
    # A release annotation can change without changing the API contract.
    return re.sub(r'The version of the OpenAPI document: [^\n]+', 'The version of the OpenAPI document: VERSION', text)
changed=[]
for source in sorted(generated.glob('*.ts')):
    destination=target/source.name
    if mode=='--write':
        shutil.copyfile(source,destination)
    elif not destination.exists() or normalized(source.read_text()) != normalized(destination.read_text()):
        changed.append(source.name)
if changed:
    raise SystemExit('Generated client differs: '+', '.join(changed)+'; inspect and run scripts/generate-api.sh --write')
print('API client '+('regenerated' if mode=='--write' else 'matches the backend contract'))
PY
