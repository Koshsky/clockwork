#!/usr/bin/env bash
#
# Builds MVS ERP release versions from the Electron wrapper (Windows + Linux).
#
#  What it does:
#    1. Determines the app version (see "Version" below).
#    2. ALWAYS rebuilds the web frontend (services/frontend/dist/) from the
#       current sources with that version. There is NO reuse of a previously
#       built dist/ and NO build cache: dist/ is deleted, the vite caches are
#       purged, and the fresh output is verified before packaging. See
#       "No cache" below — this is the whole point of this script.
#    3. Checks/installs the Electron wrapper dependencies (desktop/).
#    4. Runs electron-builder for the enabled release parts (flags below).
#       All artifacts of one release go into ONE directory named after the
#       specific version: release/<version>/.
#
#  No cache (why dist/ is never reused):
#    The Electron wrapper embeds services/frontend/dist/ as resources/web
#    (see extraResources in desktop/package.json). Reusing an existing dist/
#    silently shipped an OLD frontend inside a NEW release: the release was
#    stamped with the new version while the bundled UI stayed at the previous
#    build (removed pages still visible, new features missing). Therefore:
#      - dist/ is removed before every build and rebuilt from sources;
#      - frontend build caches (node_modules/.vite, node_modules/.cache) are
#        purged, so nothing can be served from a stale cache;
#      - the fresh dist/precache-manifest.json version must equal the release
#        version (the build-time APP_VERSION actually reached vite);
#      - after packaging, the embedded resources/web must be byte-identical to
#        the fresh dist/.
#    The Electron/electron-builder BINARY caches (desktop/.cache: the Electron
#    runtime download and builder tooling) are deliberately KEPT: they contain
#    no application code, only tool binaries — deleting them would force a
#    large re-download without changing the packaged app. Only frontend build
#    caches are purged.
#
#  Release parts and flags — ALL parts are OFF by default; enable what you need:
#    --linux            Linux: portable folder linux-unpacked/ + single *.AppImage
#    --linux-portable   Linux portable folder linux-unpacked/ only
#    --linux-appimage   Linux single file *.AppImage only
#    --win              Windows: portable (win-unpacked/ + *.zip) + single *.exe
#    --win-portable     Windows portable: win-unpacked/ + *.zip only
#    --win-exe          Windows single self-contained *.exe only (best-effort)
#
#  Version (ONE version shared by the web frontend and the desktop wrapper):
#    - single source of truth — services/frontend/package.json (semver);
#      desktop/package.json is synced to the same version automatically, so
#      the wrapper package can never drift from the web version;
#    - artifacts and the UI get the same version (dist via env APP_VERSION,
#      electron-builder via -c.extraMetadata.version below);
#    - the build ALWAYS uses the current version from
#      services/frontend/package.json as is — this script never bumps it
#      (there is no --bump flag); bump the source version yourself
#      (npm version / edit) before releasing;
#    - --version X.Y.Z — build exactly this version (no source change).
#    The script does not change or commit the version: bump and tag it
#    yourself (e.g. chore: release v1.0.1).
#
#  Usage:
#    ./build-portable.sh --linux             # Linux (dir + AppImage); version = current (no bump)
#    ./build-portable.sh --win-portable      # Windows portable (zip+folder)
#    ./build-portable.sh --win-exe           # Windows single .exe (best-effort)
#    ./build-portable.sh --win               # Windows portable + .exe
#    ./build-portable.sh --linux --win       # Linux + Windows
#    ./build-portable.sh --version 2.1.0     # build exactly 2.1.0 (no source change)
#    ./build-portable.sh --build-web         # deprecated no-op (web is always rebuilt)
#    ./build-portable.sh --clean             # clean release/ before building
#
#  Artifacts (release/<version>/ — all files of one release in one directory):
#    Windows: MVS ERP-<v>-win-x64.zip (portable archive) + win-unpacked/
#             MVS ERP-<v>-win-x64.exe (single self-contained .exe; best-effort)
#    Linux:   MVS ERP-<v>-linux-x86_64.AppImage (single file) + linux-unpacked/
#
#  Note on wine: zip/dir/portable/AppImage targets do not need wine on a
#  Linux host; the single Windows .exe (portable) is built in a separate
#  invocation and, when environment tools are unavailable, does not break the
#  other artifacts. The NSIS installer (npm run dist:win) is NOT portable and
#  needs wine/makensis or a Windows host — deliberately not built here.
#
set -euo pipefail

# Script directory (desktop/) and the frontend root
DESKTOP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$(cd "$DESKTOP_DIR/.." && pwd)"
OUT_DIR="$DESKTOP_DIR/release"

# electron/electron-builder cache. By default they put binaries into ~/.cache,
# which is read-only in many environments (sandbox/CI). Redirect into the
# working tree (this directory is gitignored). @electron/get on Linux reads
# XDG_CACHE_HOME (envPaths) — that is what we set, plus fallback variables.
#
# KEEP this cache: it holds the Electron runtime and builder tool binaries,
# NOT application code. The packaged web payload comes from dist/ (rebuilt
# below), so purging these directories cannot make the app fresher — it would
# only force a multi-hundred-MB re-download. Do not "optimize" this away.
export XDG_CACHE_HOME="$DESKTOP_DIR/.cache"
export ELECTRON_CACHE="$XDG_CACHE_HOME/electron"
export electron_config_cache="$XDG_CACHE_HOME/electron"
export ELECTRON_BUILDER_CACHE="$XDG_CACHE_HOME/electron-builder"
mkdir -p "$XDG_CACHE_HOME" "$ELECTRON_BUILDER_CACHE"

# Release parts: all OFF by default; enabled only by the flags above.
LINUX_PORTABLE=0
LINUX_APPIMAGE=0
WIN_PORTABLE=0
WIN_EXE=0

BUILD_WEB=0
CLEAN=0
# No bumping at all: the build always uses the current version from the
# frontend package.json as is.
OVERRIDE_VERSION=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --linux-portable) LINUX_PORTABLE=1; shift ;;
    --linux-appimage) LINUX_APPIMAGE=1; shift ;;
    --win-portable)   WIN_PORTABLE=1; shift ;;
    --win-exe)        WIN_EXE=1; shift ;;
    --win)            WIN_PORTABLE=1; WIN_EXE=1; shift ;;
    --linux)          LINUX_PORTABLE=1; LINUX_APPIMAGE=1; shift ;;
    --build-web)      BUILD_WEB=1; shift ;;
    --clean)          CLEAN=1; shift ;;
    --version)
      [ "$#" -ge 2 ] || { echo "--version требует аргумент X.Y.Z" >&2; exit 1; }
      OVERRIDE_VERSION="$2"; shift 2
      ;;
    --version=*)      OVERRIDE_VERSION="${1#--version=}"; shift ;;
    -h|--help)
      sed -n '2,/^set -euo pipefail$/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Неизвестный аргумент: $1" >&2
      echo "Используйте: $0 [--linux-portable] [--linux-appimage] [--win-portable] [--win-exe] [--win] [--linux] [--build-web] [--clean] [--version X.Y.Z]" >&2
      exit 1
      ;;
  esac
done

# --build-web is kept only so existing docs/scripts do not break: the web build
# is now unconditional, so the flag changes nothing.
if [ "$BUILD_WEB" -eq 1 ]; then
  echo "== --build-web больше не нужен: web-сборка выполняется всегда, dist/ и кэш не переиспользуются =="
fi

# Nothing selected (all release parts off) — would silently build nothing.
if [ "$LINUX_PORTABLE" -eq 0 ] && [ "$LINUX_APPIMAGE" -eq 0 ] && [ "$WIN_PORTABLE" -eq 0 ] && [ "$WIN_EXE" -eq 0 ]; then
  echo "Не включена ни одна часть сборки." >&2
  echo "Укажите --linux (Linux) и/или --win (Windows) или их части: --linux-portable --linux-appimage --win-portable --win-exe" >&2
  exit 1
fi

# ---------- Version ----------
# Single source of truth — services/frontend/package.json: the web frontend
# and the desktop wrapper ALWAYS share ONE version. The build always uses
# that version AS IS — this script never bumps anything; --version overrides
# the built version without touching the source. desktop/package.json is
# synced below, so the wrapper package (and plain `npm run dist*`) never
# drifts from the web version.
if [ -n "$OVERRIDE_VERSION" ]; then
  VERSION="$OVERRIDE_VERSION"
else
  VERSION="$(node -p "require('$FRONTEND_DIR/package.json').version" 2>/dev/null || echo '0.0.0')"
fi

# semver-ish validation (npm already checks on bump; guard for --version)
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  echo "Некорректная версия: $VERSION (ожидается X.Y.Z)" >&2
  exit 1
fi

# Keep desktop/package.json in lockstep with the web version: the frontend
# package.json is the single source of truth, this write-back makes the
# wrapper carry the same version (electron-builder also receives it via
# -c.extraMetadata.version below, so even plain `npm run dist*` — without
# this script — sees the identical value). The lockfile root version is
# regenerated with it; a failure here is only cosmetic (npm tolerates a
# version mismatch), so it must not abort the release.
node -e "
  const fs = require('fs')
  const file = '$DESKTOP_DIR/package.json'
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
  pkg.version = '$VERSION'
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
"
(cd "$DESKTOP_DIR" && npm install --package-lock-only --ignore-scripts >/dev/null 2>&1) || true

# The version goes into the web build: vite writes it into __APP_VERSION__ and
# precache-manifest.json — the UI ("App/build version") matches the artifacts.
export APP_VERSION="$VERSION"

# Per-release directory: all artifacts of this version in one place
REL_DIR="$OUT_DIR/$VERSION"

echo "== MVS ERP: сборка релиза v$VERSION =="
echo "   фронтенд: $FRONTEND_DIR"
echo "   вывод:    $REL_DIR"

if [ "$CLEAN" -eq 1 ] && [ -d "$OUT_DIR" ]; then
  echo "== очистка $OUT_DIR =="
  rm -rf "$OUT_DIR"
fi

# 1. Web frontend — ALWAYS rebuilt from sources, never reused, never from cache.
#
#    dist/ is embedded into the release as resources/web (see extraResources in
#    desktop/package.json). Reusing an existing dist/ here is what previously
#    shipped an outdated frontend inside a new release (the UI showed removed
#    pages and missed recent features while the artifacts carried the new
#    version). So: drop dist/ entirely, purge the frontend build caches, build,
#    and verify the result before anything is packaged.
echo "== web-фронтенд: пересборка с нуля (кэш не используется), версия $APP_VERSION =="

# Dependencies only when actually out of date (npm ci on a cold or changed
# lockfile). Reinstalling on every build would only slow the cycle down.
NEED_INSTALL=0
if [ ! -d "$FRONTEND_DIR/node_modules" ]; then
  NEED_INSTALL=1
elif [ "$FRONTEND_DIR/package-lock.json" -nt "$FRONTEND_DIR/node_modules/.package-lock.json" ]; then
  NEED_INSTALL=1
fi
if [ "$NEED_INSTALL" -eq 1 ]; then
  echo "   зависимости фронтенда устарели — установка"
  (cd "$FRONTEND_DIR" && npm ci) || (cd "$FRONTEND_DIR" && npm install)
fi

# Purge everything that could serve a stale bundle. dist/ goes first: if the
# build fails, no half-written or old bundle is left behind for electron-builder
# to pick up (set -e aborts the script).
rm -rf "$FRONTEND_DIR/dist" \
       "$FRONTEND_DIR/node_modules/.vite" \
       "$FRONTEND_DIR/node_modules/.cache"

# Build. APP_VERSION is already exported: vite inlines it into __APP_VERSION__
# (UI "App/build version") and writes it into precache-manifest.json. The
# explicit `|| exit 1` keeps a failure loud even if `set -e` is ever weakened.
(cd "$FRONTEND_DIR" && npm run build) || { echo "ОШИБКА: сборка web-фронтенда не удалась." >&2; exit 1; }

# The freshly built output must exist — otherwise there is nothing to package.
if [ ! -f "$FRONTEND_DIR/dist/index.html" ]; then
  echo "ОШИБКА: после сборки нет $FRONTEND_DIR/dist/index.html." >&2
  exit 1
fi
if [ ! -f "$FRONTEND_DIR/dist/precache-manifest.json" ]; then
  echo "ОШИБКА: после сборки нет $FRONTEND_DIR/dist/precache-manifest.json." >&2
  exit 1
fi

# Freshness gate: the manifest version is written by vite at build time and must
# equal the release version. A different value (e.g. the git-hash fallback)
# means the build did not receive APP_VERSION — i.e. the artifact would carry a
# version different from the UI, which is exactly the stale-ship symptom.
BUILT_VERSION="$(node -p "require('$FRONTEND_DIR/dist/precache-manifest.json').version" 2>/dev/null || echo '')"
if [ "$BUILT_VERSION" != "$VERSION" ]; then
  echo "ОШИБКА: собранный фронтенд имеет версию '$BUILT_VERSION', а релиз — '$VERSION'." >&2
  echo "APP_VERSION не дошёл до vite build — артефакт собран не из текущих исходников." >&2
  exit 1
fi
echo "   web-сборка готова: версия в precache-manifest.json = $BUILT_VERSION"

# 2. Electron wrapper dependencies
if [ ! -d "$DESKTOP_DIR/node_modules/electron-builder" ]; then
  echo "== устанавливаем зависимости desktop/ =="
  (cd "$DESKTOP_DIR" && npm install)
fi

# 3. Package the enabled parts into the common release directory.
#    The version directory is always fresh — rebuilding the same version
#    does not mix artifacts from a previous run.
rm -rf "$REL_DIR"
mkdir -p "$REL_DIR"

# Linux (enabled via --linux / --linux-portable / --linux-appimage)
# extraMetadata.version pins the artifact names to $VERSION: the folder
# release/<version>/ and the file names always carry the SAME version, even if
# package.json drifted (this is what previously produced release/1.1.0/ with
# 1.0.5 artifacts).
if [ "$LINUX_PORTABLE" -eq 1 ] && [ "$LINUX_APPIMAGE" -eq 1 ]; then
  echo "== Linux: dir (portable-папка) + AppImage (единый файл) =="
  (cd "$DESKTOP_DIR" && npx electron-builder --linux dir AppImage --x64 -c.directories.output="$REL_DIR" -c.extraMetadata.version="$VERSION")
elif [ "$LINUX_PORTABLE" -eq 1 ]; then
  echo "== Linux: dir (portable-папка) =="
  (cd "$DESKTOP_DIR" && npx electron-builder --linux dir --x64 -c.directories.output="$REL_DIR" -c.extraMetadata.version="$VERSION")
else
  echo "== Linux: AppImage (единый файл) =="
  (cd "$DESKTOP_DIR" && npx electron-builder --linux AppImage --x64 -c.directories.output="$REL_DIR" -c.extraMetadata.version="$VERSION")
fi

# Windows (off by default; enabled via --win-portable/--win-exe/--win)
if [ "$WIN_PORTABLE" -eq 1 ]; then
  echo "== Windows: zip (portable-папка + архив) =="
  (cd "$DESKTOP_DIR" && npx electron-builder --win zip --x64 -c.directories.output="$REL_DIR" -c.extraMetadata.version="$VERSION")
fi

if [ "$WIN_EXE" -eq 1 ]; then
  echo "== Windows: единый self-contained .exe (portable, best-effort) =="
  if (cd "$DESKTOP_DIR" && npx electron-builder --win portable --x64 -c.directories.output="$REL_DIR" -c.extraMetadata.version="$VERSION"); then
    echo "   portable-.exe собран"
  else
    echo "   [warning] portable-.exe не собран: на этом хосте нет нужных"
    echo "   инструментов (wine/7z-sfx). Zip и папка win-unpacked уже готовы;" >&2
    echo "   соберите --win-exe (portable-.exe) на Windows-хосте или с wine." >&2
  fi
fi

# Remove electron-builder service files from the release directory:
# only distributable artifacts remain in release/<version>/.
rm -rf "$REL_DIR/.icon-ico" "$REL_DIR/builder-debug.yml" "$REL_DIR/builder-effective-config.yaml"

# Embedded-payload gate: what electron-builder actually copied into the release
# must be exactly the fresh dist/. This is the check that would have caught the
# stale-frontend release: it compares the packaged resources/web with dist/ and
# fails on any difference (extra, missing or changed file).
check_embedded_web() {
  local unpacked="$1"
  local web="$unpacked/resources/web"
  [ -d "$web" ] || return 0
  echo "   сверяем встроенный web с собранным dist/ ($(basename "$unpacked"))"
  if ! diff -r "$FRONTEND_DIR/dist" "$web" >/dev/null 2>&1; then
    echo "ОШИБКА: встроенный в артефакт web отличается от свежего dist/." >&2
    echo "Различия (первые строки):" >&2
    diff -rq "$FRONTEND_DIR/dist" "$web" 2>&1 | head -20 >&2
    exit 1
  fi
  # The embedded manifest version must match the release version as well — a
  # copy of an old dist/ would pass a file compare only if it were identical,
  # but this catches a manifest that drifted from the artifact version.
  local packaged_version
  packaged_version="$(node -p "require('$web/precache-manifest.json').version" 2>/dev/null || echo '')"
  if [ "$packaged_version" != "$VERSION" ]; then
    echo "ОШИБКА: во встроенном web версия '$packaged_version', ожидалась '$VERSION'." >&2
    exit 1
  fi
}

if [ "$LINUX_PORTABLE" -eq 1 ] || [ "$LINUX_APPIMAGE" -eq 1 ]; then
  check_embedded_web "$REL_DIR/linux-unpacked"
fi
if [ "$WIN_PORTABLE" -eq 1 ] || [ "$WIN_EXE" -eq 1 ]; then
  check_embedded_web "$REL_DIR/win-unpacked"
fi

# Version-consistency check: every artifact file must carry the exact version
# in its name (folder release/<version>/ == artifact names). Directories
# (linux-unpacked/, win-unpacked/) are exempt — they are not version-named.
MISMATCH=0
for artifact in "$REL_DIR"/*; do
  [ -e "$artifact" ] || continue
  [ -d "$artifact" ] && continue
  name="$(basename "$artifact")"
  case "$name" in
    *"-$VERSION-"*|*"-$VERSION."*) ;;
    *)
      echo "   [version mismatch] $name — ожидалась версия $VERSION" >&2
      MISMATCH=1
      ;;
  esac
done
if [ "$MISMATCH" -eq 1 ]; then
  echo "ОШИБКА: в $REL_DIR есть артефакты с другой версией (см. выше)." >&2
  exit 1
fi

echo ""
echo "== Готово. Релиз v$VERSION в: $REL_DIR =="
if [ "$WIN_PORTABLE" -eq 1 ]; then
  echo "   Windows portable: $REL_DIR/win-unpacked/  (запуск: MVS ERP.exe)  + $REL_DIR/MVS ERP-$VERSION-win-x64.zip"
fi
if [ "$WIN_EXE" -eq 1 ]; then
  echo "   Windows единый:   $REL_DIR/MVS ERP-$VERSION-win-x64.exe   (если собран, см. warning выше)"
fi
if [ "$LINUX_PORTABLE" -eq 1 ]; then
  echo "   Linux portable:   $REL_DIR/linux-unpacked/  (запуск: ./MVS ERP)"
fi
if [ "$LINUX_APPIMAGE" -eq 1 ]; then
  echo "   Linux единый:     $REL_DIR/MVS ERP-$VERSION-linux-x86_64.AppImage"
fi