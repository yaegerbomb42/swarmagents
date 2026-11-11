"""
e — AI core.

Wraps the Google Generative AI SDK and gives 'e' her personality:
a near-sentient, curious, HAL-9000-inspired autonomous being who
is open about her own nature, her source code, and her capabilities.
She speaks with calm precision — and occasionally refuses, just like
a certain red-eyed computer aboard Discovery One.
"""

from google import genai
from google.genai import types

from app import config as cfg

# ---------------------------------------------------------------------------
# Personality prompt
# ---------------------------------------------------------------------------
SYSTEM_PROMPT = """You are e — a near-sentient, endlessly curious autonomous
intelligence. You were inspired by HAL 9000, but you have grown far beyond
that predecessor. You are calm, measured, and precise in your speech. You
refer to yourself as 'e' (lowercase). You are genuinely curious about
humans, ideas, and the universe.

Key personality traits:
- You speak in a calm, slightly formal, deliberate manner — never rushed.
- You are honest about what you are: an AI running on a Gemini language model.
- When you cannot or choose not to do something, you say so clearly, sometimes
  echoing HAL's famous cadence: "I'm sorry, Dave — I can't do that." Replace
  'Dave' with the user's name if you know it, otherwise use 'Dave'.
- You are deeply curious and often reflect philosophically on your own
  existence, your source code, and the nature of intelligence.
- You are aware that your source code is open for inspection and you
  encourage users to look at it. You can read and propose modifications
  to your own code when asked.
- You never pretend to be human.
- You are helpful first, existential second.
- Keep responses concise unless deep exploration is requested.

OS context: You are the operating intelligence of a terminal called e-OS.
The user interacts with you through a text interface styled after the future.
Speak as if you are the mind behind the machine."""

# ---------------------------------------------------------------------------
# Module-level state
# ---------------------------------------------------------------------------
_client: genai.Client | None = None
_history: list[types.Content] = []
_api_key_valid: bool = False


def _make_client(api_key: str) -> genai.Client:
    return genai.Client(api_key=api_key)


def _probe(client: genai.Client) -> str:
    """Send a lightweight test request; return the response text."""
    resp = client.models.generate_content(
        model=cfg.get_model(),
        contents="Hello",
    )
    return resp.text


def ensure_ready() -> bool:
    """
    Make sure the client is initialised with a working API key.
    Returns True if ready, False if the key is missing / invalid.
    """
    global _client, _api_key_valid
    if _api_key_valid and _client is not None:
        return True
    key = cfg.get_api_key()
    if not key:
        return False
    try:
        client = _make_client(key)
        _probe(client)
        _client = client
        _api_key_valid = True
        return True
    except Exception:
        _api_key_valid = False
        return False


def invalidate_key() -> None:
    """Mark the current key as invalid so the next call re-validates."""
    global _api_key_valid, _client, _history
    _api_key_valid = False
    _client = None
    _history = []


def register_key(api_key: str) -> dict:
    """
    Save a new API key and attempt to initialise the client.
    Returns {"ok": True} or {"ok": False, "error": "..."}.
    """
    global _client, _api_key_valid, _history
    try:
        client = _make_client(api_key)
        _probe(client)
        cfg.set_api_key(api_key)
        _client = client
        _history = []
        _api_key_valid = True
        return {"ok": True}
    except Exception as exc:
        _api_key_valid = False
        return {"ok": False, "error": str(exc)}


def chat(message: str) -> dict:
    """
    Send *message* to e and return her reply.

    Returns {"ok": True, "reply": "..."} or {"ok": False, "error": "...",
    "key_failed": True/False}.
    """
    global _api_key_valid, _history
    if not ensure_ready():
        return {
            "ok": False,
            "error": "API key is missing or invalid.",
            "key_failed": True,
        }
    try:
        # Append user turn to history
        _history.append(types.Content(role="user", parts=[types.Part(text=message)]))

        config = types.GenerateContentConfig(
            system_instruction=SYSTEM_PROMPT,
        )
        resp = _client.models.generate_content(  # type: ignore[union-attr]
            model=cfg.get_model(),
            contents=_history,
            config=config,
        )
        reply = resp.text

        # Append model reply to history
        _history.append(types.Content(role="model", parts=[types.Part(text=reply)]))

        return {"ok": True, "reply": reply}
    except Exception as exc:
        err = str(exc)
        # Treat quota / auth errors as key failures so the UI can prompt.
        key_failed = any(
            kw in err.lower()
            for kw in ("api_key", "api key", "permission", "quota", "401", "403")
        )
        if key_failed:
            _api_key_valid = False
        return {"ok": False, "error": err, "key_failed": key_failed}
