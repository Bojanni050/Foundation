import json
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

def load_state(state_file: Path):
    if state_file.exists():
        return json.loads(state_file.read_text(encoding="utf-8"))
    return {"imported_urls": []}

def save_state(state_file: Path, state):
    state_file.write_text(json.dumps(state, indent=2), encoding="utf-8")

def post_import(api_url, token, payload, retries=2):
    # Ingestie Gateway (Foundation, server/routes/ingest.js): de chat-entry-
    # point staat turns, sourceProvider en url toe; status en dedup-identiteit
    # (provider_conversation_id uit de url) zijn server-eigendom. Onbekende
    # velden = 422 — dit dictaat volgt het contract exact.
    req = urllib.request.Request(
        f"{api_url}/api/ingest/chat",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        method="POST",
    )
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            return e.code, {"error": e.read().decode("utf-8", "ignore")}
        except (urllib.error.URLError, OSError) as e:
            if attempt < retries:
                print(f"    ! import request failed ({e}), retrying...")
                time.sleep(2)
                continue
            return 0, {"error": str(e)}

def post_attachment(api_url, token, data, filename, mime_type, retries=1):
    req = urllib.request.Request(
        f"{api_url}/api/attachments",
        data=data,
        headers={
            "Content-Type": mime_type or "application/octet-stream",
            "Authorization": f"Bearer {token}",
            "X-Attachment-Filename": urllib.parse.quote(filename),
        },
        method="POST",
    )
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except (urllib.error.HTTPError, urllib.error.URLError, OSError) as e:
            if attempt < retries:
                time.sleep(2)
                continue
            print(f"    ! attachment upload failed for {filename!r}: {e}")
            return None
