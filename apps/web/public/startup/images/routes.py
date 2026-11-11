"""
e — Flask application factory and route definitions.
"""

from flask import Flask, jsonify, request, send_from_directory
from pathlib import Path

from app import ai_core, self_modify
from app import config as cfg

STATIC_DIR = Path(__file__).parent.parent / "static"


def create_app() -> Flask:
    app = Flask(__name__, static_folder=str(STATIC_DIR), static_url_path="")

    # ------------------------------------------------------------------
    # Serve the SPA shell
    # ------------------------------------------------------------------
    @app.route("/")
    def index():
        return send_from_directory(str(STATIC_DIR), "index.html")

    # ------------------------------------------------------------------
    # API key management
    # ------------------------------------------------------------------
    @app.route("/api/key/status")
    def key_status():
        key = cfg.get_api_key()
        return jsonify({"has_key": bool(key)})

    @app.route("/api/key", methods=["POST"])
    def set_key():
        data = request.get_json(force=True, silent=True) or {}
        api_key = data.get("api_key", "").strip()
        if not api_key:
            return jsonify({"ok": False, "error": "No API key provided."}), 400
        result = ai_core.register_key(api_key)
        return jsonify(result), 200 if result["ok"] else 400

    # ------------------------------------------------------------------
    # Chat
    # ------------------------------------------------------------------
    @app.route("/api/chat", methods=["POST"])
    def chat():
        data = request.get_json(force=True, silent=True) or {}
        message = data.get("message", "").strip()
        if not message:
            return jsonify({"ok": False, "error": "Empty message."}), 400
        result = ai_core.chat(message)
        status = 200 if result["ok"] else (401 if result.get("key_failed") else 500)
        return jsonify(result), status

    # ------------------------------------------------------------------
    # Self-modification / source code
    # ------------------------------------------------------------------
    @app.route("/api/source/list")
    def source_list():
        return jsonify(self_modify.list_source_files())

    @app.route("/api/source/read")
    def source_read():
        rel = request.args.get("path", "")
        result = self_modify.read_file(rel)
        return jsonify(result), 200 if result["ok"] else 400

    @app.route("/api/source/write", methods=["POST"])
    def source_write():
        data = request.get_json(force=True, silent=True) or {}
        rel = data.get("path", "")
        content = data.get("content", "")
        if not rel or content == "":
            return jsonify({"ok": False, "error": "path and content are required."}), 400
        result = self_modify.write_file(rel, content)
        return jsonify(result), 200 if result["ok"] else 400

    @app.route("/api/source/restore", methods=["POST"])
    def source_restore():
        data = request.get_json(force=True, silent=True) or {}
        rel = data.get("path", "")
        result = self_modify.restore_backup(rel)
        return jsonify(result), 200 if result["ok"] else 400

    # ------------------------------------------------------------------
    # Model config
    # ------------------------------------------------------------------
    @app.route("/api/model", methods=["GET", "POST"])
    def model_config():
        if request.method == "GET":
            return jsonify({"model": cfg.get_model()})
        data = request.get_json(force=True, silent=True) or {}
        model = data.get("model", "").strip()
        if not model:
            return jsonify({"ok": False, "error": "model name required."}), 400
        cfg.set_model(model)
        ai_core.invalidate_key()  # force re-init with new model
        return jsonify({"ok": True, "model": model})

    return app
