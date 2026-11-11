#!/usr/bin/env python3
"""Guard ignored local state and the shared repository layout."""
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parent.parent
ignored = [
    '.env', 'frontend/.env.local', 'backend/.env', 'local',
    'backups/db.dump', 'server-backup-2026-11-09/db.dump',
    'frontend/node_modules', 'backend/build/service',
    'frontend/dist/index.html', 'frontend/desktop/release/app.exe',
    'backend/migrations/plugins/V1000__private.sql',
    'backend/migrations/seed/V1020__users.sql',
    'backend/migrations/seed/passwords.txt',
]
visible = [
    '.env.example', 'frontend/.env.example', 'backend/.env.example',
    'frontend/src/api/api.ts', 'frontend/desktop/build/icon.png',
    'backend/migrations/plugins/.gitkeep', 'backend/migrations/seed/.gitkeep',
]
for paths, expected in [(ignored, True), (visible, False)]:
    for path in paths:
        result = subprocess.run(['git', 'check-ignore', '--no-index', '-q', path], cwd=root)
        if (result.returncode == 0) != expected:
            raise SystemExit('Unexpected ignore policy: ' + path)
for component in ['backend', 'frontend']:
    if (root / component / '.gitignore').exists():
        raise SystemExit('Use the shared root .gitignore')
    if not (root / component / '.dockerignore').is_file():
        raise SystemExit('Missing service Docker context policy')
tracked = subprocess.check_output(['git', 'ls-files', '-z'], cwd=root, text=True).split('\0')
for path in tracked:
    # Glob filters cannot reliably select paths containing line separators.
    if any(character in path for character in '\r\n\u2028\u2029'):
        raise SystemExit('Unsupported line separator in tracked path: ' + repr(path))
    if path in ignored or path.startswith(('local/', 'backups/', 'server-backup')):
        raise SystemExit('Local state is tracked: ' + path)
print('PASS: shared ignore policy and service context boundaries')
