"""Compatibility entry point for the source-based Node frontend build."""
from pathlib import Path
import shutil
import subprocess

if __name__ == '__main__':
    node = shutil.which('node')
    if not node:
        raise SystemExit('Node.js is required. Run npm ci before building.')
    subprocess.run([node, 'tools/build-frontend.mjs'], cwd=Path(__file__).resolve().parents[1], check=True)
