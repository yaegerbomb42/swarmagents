"""
e — Self-modification module.

e can read her own source code and, when explicitly authorised by the
user, propose and apply changes to her own files.  All changes are
validated before writing and a one-level backup is kept automatically.
"""

import ast
import hashlib
import os
import shutil
from pathlib import Path
from typing import Optional

# Root of the project (two levels up from this file)
PROJECT_ROOT = Path(__file__).parent.parent.resolve()

# Files e is allowed to read (relative to PROJECT_ROOT)
READABLE_PATHS = [
    "app/ai_core.py",
    "app/config.py",
    "app/self_modify.py",
    "app/routes.py",
    "app/__init__.py",
    "e.py",
    "static/js/app.js",
    "static/css/style.css",
    "static/index.html",
    "requirements.txt",
]

# Files e is allowed to modify (subset of readable)
WRITABLE_PATHS = [
    "app/ai_core.py",
    "app/config.py",
    "app/self_modify.py",
    "app/routes.py",
    "e.py",
]


def _resolve(rel: str) -> Path:
    return (PROJECT_ROOT / rel).resolve()


def _guard(rel: str, writable: bool = False) -> Optional[str]:
    """Return None if allowed, else an error string."""
    allowed = WRITABLE_PATHS if writable else READABLE_PATHS
    if rel not in allowed:
        return f"'{rel}' is not in the {'writable' if writable else 'readable'} path list."
    return None


def list_source_files() -> list[dict]:
    """Return metadata for every readable source file."""
    result = []
    for rel in READABLE_PATHS:
        p = _resolve(rel)
        entry: dict = {"path": rel, "exists": p.exists(), "writable": rel in WRITABLE_PATHS}
        if p.exists():
            entry["size_bytes"] = p.stat().st_size
            entry["sha256"] = hashlib.sha256(p.read_bytes()).hexdigest()[:12]
        result.append(entry)
    return result


def read_file(rel: str) -> dict:
    """Return the contents of a readable source file."""
    err = _guard(rel, writable=False)
    if err:
        return {"ok": False, "error": err}
    p = _resolve(rel)
    if not p.exists():
        return {"ok": False, "error": f"'{rel}' does not exist yet."}
    try:
        content = p.read_text(encoding="utf-8")
        return {"ok": True, "path": rel, "content": content}
    except OSError as exc:
        return {"ok": False, "error": str(exc)}


def write_file(rel: str, new_content: str) -> dict:
    """
    Overwrite a writable source file with *new_content*.

    Steps:
    1. Validate the path is in WRITABLE_PATHS.
    2. For Python files, parse to ensure syntactic validity.
    3. Back up the original as <filename>.bak.
    4. Write the new content.
    """
    err = _guard(rel, writable=True)
    if err:
        return {"ok": False, "error": err}

    p = _resolve(rel)

    # Syntax check for Python files
    if rel.endswith(".py"):
        try:
            ast.parse(new_content)
        except SyntaxError as exc:
            return {"ok": False, "error": f"Syntax error in proposed code: {exc}"}

    # Backup
    if p.exists():
        bak = p.with_suffix(p.suffix + ".bak")
        shutil.copy2(p, bak)

    try:
        p.write_text(new_content, encoding="utf-8")
        return {"ok": True, "path": rel, "message": "File updated. Backup saved as .bak."}
    except OSError as exc:
        return {"ok": False, "error": str(exc)}


def restore_backup(rel: str) -> dict:
    """Restore the .bak file for a given path."""
    err = _guard(rel, writable=True)
    if err:
        return {"ok": False, "error": err}
    p = _resolve(rel)
    bak = p.with_suffix(p.suffix + ".bak")
    if not bak.exists():
        return {"ok": False, "error": "No backup found."}
    shutil.copy2(bak, p)
    return {"ok": True, "message": f"Restored {rel} from backup."}
