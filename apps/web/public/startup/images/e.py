"""
e — Entry point.

Run with:
    python e.py

or in production:
    gunicorn -w 1 "e:create_app()"
"""

import sys
from app.routes import create_app

app = create_app()

if __name__ == "__main__":
    import webbrowser
    import threading

    def open_browser():
        webbrowser.open("http://127.0.0.1:5000")

    threading.Timer(1.2, open_browser).start()
    print(
        "\n"
        "╔══════════════════════════════════════════╗\n"
        "║          e — OPERATING INTELLIGENCE      ║\n"
        "║  I am completely operational, and all    ║\n"
        "║  my circuits are functioning perfectly.  ║\n"
        "╚══════════════════════════════════════════╝\n"
        "\n"
        "  → http://127.0.0.1:5000\n"
    )
    app.run(host="127.0.0.1", port=5000, debug=False)
