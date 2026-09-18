"""Shared, project-relative configuration for the local tools and dashboard."""

import json
import os
from pathlib import Path
import tempfile


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SETTINGS_NAME = "magic_rag_settings.json"
DEFAULT_MCP_PORT = 32187
DEFAULT_UI_PORT = 32188


def validate_settings(settings):
    if not isinstance(settings, dict):
        raise ValueError(f"{SETTINGS_NAME} must contain a JSON object.")
    folders = settings.get("folders")
    if not isinstance(folders, list) or any(
        not isinstance(folder, str) or not folder.strip() for folder in folders
    ):
        raise ValueError(f"{SETTINGS_NAME} 'folders' must be an array of non-empty paths.")
    for name in ("mcp_port", "ui_port"):
        value = settings.get(name)
        if type(value) is not int or not 1 <= value <= 65535:
            raise ValueError(f"{name} must be a whole number between 1 and 65535.")
    if settings["mcp_port"] == settings["ui_port"]:
        raise ValueError("The MCP and dashboard ports must be different.")
    return settings


def load_settings(root=PROJECT_ROOT):
    root = Path(root)
    path = root / SETTINGS_NAME
    values = json.loads(path.read_text(encoding="utf-8-sig")) if path.exists() else {}
    if not isinstance(values, dict):
        raise ValueError(f"{SETTINGS_NAME} must contain a JSON object.")
    return validate_settings({
        "folders": [str(root / "raw")],
        "mcp_port": DEFAULT_MCP_PORT,
        "ui_port": DEFAULT_UI_PORT,
        **values,
    })


def resolve_folder(folder, root=PROJECT_ROOT):
    path = Path(folder.strip()).expanduser()
    return (path if path.is_absolute() else Path(root) / path).resolve()


def folder_statuses(settings, root=PROJECT_ROOT):
    result = []
    for folder in settings["folders"]:
        try:
            path = resolve_folder(folder, root)
            available = path.is_dir() and os.access(path, os.R_OK)
            result.append({"path": folder, "resolved": str(path), "available": available})
        except (OSError, ValueError) as error:
            result.append({"path": folder, "resolved": folder, "available": False, "error": str(error)})
    return result


def atomic_json(path, values):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         prefix=path.name + ".", suffix=".tmp", delete=False) as stream:
            temporary = stream.name
            json.dump(values, stream, indent=2, ensure_ascii=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


def save_settings(changes, root=PROJECT_ROOT):
    if not isinstance(changes, dict) or set(changes) - {"folders", "mcp_port", "ui_port"}:
        raise ValueError("Only folders, mcp_port, and ui_port can be changed.")
    # Reading first preserves unknown fields and refuses to overwrite malformed JSON.
    previous = load_settings(root)
    settings = validate_settings({**previous, **changes})
    if "folders" in changes:
        existing = {os.path.normcase(str(resolve_folder(folder, root))) for folder in previous["folders"]}
        seen = set()
        for folder in folder_statuses(settings, root):
            key = os.path.normcase(folder["resolved"])
            if key in seen:
                raise ValueError(f"Folder is already in the list: {folder['path']}")
            seen.add(key)
            if not folder["available"] and key not in existing:
                raise ValueError(f"Folder is unavailable: {folder['path']}")
        settings["folders"] = [folder.strip() for folder in settings["folders"]]
    atomic_json(Path(root) / SETTINGS_NAME, settings)
    return settings
