#!/usr/bin/env python3
"""FPL AI Manager — zero-dependency, local, read-only web app.

Uses only public FPL endpoints. Nothing logs in or modifies the actual FPL team.
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
API_BASE = "https://fantasy.premierleague.com/api/"
CACHE = {}
CACHE_LOCK = threading.RLock()
DEFAULT_TEAM_ID = 144616


def fetch(path, max_age=600):
    """Fetch a fixed API path; caching reduces traffic to FPL."""
    now = time.monotonic()
    with CACHE_LOCK:
        cached = CACHE.get(path)
        if cached and now - cached[0] < max_age:
            return cached[1]
    req = Request(API_BASE + path, headers={
        "User-Agent": "Mozilla/5.0 (compatible; PersonalFPLPlanner/1.0; local read-only)",
        "Accept": "application/json",
    })
    try:
        with urlopen(req, timeout=16) as r:
            result = json.load(r)
    except HTTPError as ex:
        raise RuntimeError(f"FPL returned HTTP {ex.code} for {path}.") from ex
    except (URLError, TimeoutError) as ex:
        raise RuntimeError(f"Could not reach the FPL website: {ex}. Check your internet access, or try again.") from ex
    except json.JSONDecodeError as ex:
        raise RuntimeError("FPL returned unexpected data. Try again later.") from ex
    with CACHE_LOCK:
        CACHE[path] = (now, result)
    return result


def get_published_gw(events, entry_id):
    # A squad becomes public only when that gameweek's deadline has passed.
    now = datetime.now(timezone.utc)
    eligible = []
    for ev in events:
        if not isinstance(ev, dict):
            continue
        try:
            deadline = datetime.fromisoformat(ev["deadline_time"].replace("Z", "+00:00"))
        except (KeyError, ValueError):
            continue
        if deadline <= now:
            eligible.append(ev["id"])
    for gw in sorted(eligible, reverse=True)[:4]:
        try:
            item = fetch(f"entry/{entry_id}/event/{gw}/picks/", 600)
            if item.get("picks"):
                return gw, item
        except RuntimeError:
            continue
    raise RuntimeError("No published squad was found for this team yet. FPL may be updating, or the team has no completed gameweek.")


def build_data(entry_id):
    boot = fetch("bootstrap-static/", 1800)
    fixtures = fetch("fixtures/", 3600)
    entry = fetch(f"entry/{entry_id}/", 600)
    history = fetch(f"entry/{entry_id}/history/", 600)
    published_gw, published_picks = get_published_gw(boot.get("events", []), entry_id)

    # Future/ongoing GWs whose deadlines have not passed. The current published
    # GW is included if its matches are still being played, for context only.
    now = datetime.now(timezone.utc)
    planning = []
    for ev in boot.get("events", []):
        if not isinstance(ev, dict):
            continue
        try:
            deadline = datetime.fromisoformat(ev["deadline_time"].replace("Z", "+00:00"))
        except (KeyError, ValueError):
            continue
        if deadline > now:
            planning.append({"id": ev["id"], "deadline_time": ev.get("deadline_time"), "name": ev.get("name")})
    planning = planning[:8]
    if not planning:
        raise RuntimeError("There are no future gameweeks currently listed in FPL.")

    # Send only documented, public fields needed by the UI.
    keep = (
        "id", "first_name", "second_name", "web_name", "team", "element_type",
        "now_cost", "form", "points_per_game", "total_points", "ep_next",
        "minutes", "status", "news", "chance_of_playing_next_round",
        "selected_by_percent", "expected_goals", "expected_assists", "starts",
        "goals_scored", "assists", "clean_sheets", "defensive_contribution",
    )
    players = [{k: p.get(k) for k in keep} for p in boot.get("elements", [])]
    team_keep = ("id", "name", "short_name")
    clubs = [{k: t.get(k) for k in team_keep} for t in boot.get("teams", [])]
    fixtures_clean = [{k: f.get(k) for k in (
        "event", "team_h", "team_a", "team_h_difficulty", "team_a_difficulty",
        "kickoff_time", "finished", "started")}
        for f in fixtures if f.get("event") in {x["id"] for x in planning}]
    current_hist = history.get("current", [])
    last_hist = next((h for h in reversed(current_hist) if h.get("event") == published_gw),
                     current_hist[-1] if current_hist else {})
    return {
        "mode": "live", "team_id": entry_id,
        "total_players": boot.get("total_players") if type(boot.get("total_players")) is int and boot["total_players"] > 0 else None,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "entry": {k: entry.get(k) for k in ("id", "name", "player_first_name", "player_last_name", "summary_overall_points", "summary_overall_rank", "last_deadline_total_transfers")},
        "published_gw": published_gw,
        "picks": [{k: p.get(k) for k in ("element", "position", "multiplier", "is_captain", "is_vice_captain")} for p in published_picks["picks"]],
        "bank": (last_hist.get("bank") or 0) / 10,
        "team_value": (last_hist.get("value") or 0) / 10,
        "history": [{k: h.get(k) for k in ("event", "points", "total_points", "overall_rank")} for h in current_hist[-8:]],
        "used_chips": [{"name": c.get("name"), "event": c.get("event")} for c in history.get("chips", [])],
        "gameweeks": planning,
        "players": players,
        "clubs": clubs,
        "fixtures": fixtures_clean,
        "disclaimer": "Unofficial read-only FPL data. Latest transfers, actual selling prices, free transfers and currently available chips may require login; confirm all moves in FPL.",
    }



def gameweek_results(entry_id, gameweek):
    """Return official per-player GW points only after FPL has finalised the GW.

    Provisional bonus/points must not be treated as final training labels.
    """
    boot = fetch("bootstrap-static/", 600)
    event = next((v for v in boot.get("events", []) if v.get("id") == gameweek), None)
    if not event:
        raise ValueError("Unknown gameweek")
    complete = bool(event.get("finished") and event.get("data_checked"))
    if not complete:
        return {"gameweek": gameweek, "final": False, "reason": "Waiting for FPL to finish and verify gameweek points."}
    live = fetch(f"event/{gameweek}/live/", 43200)
    points = {}
    for row in live.get("elements", []):
        pid, score = row.get("id"), row.get("stats", {}).get("total_points")
        if type(pid) is int and type(score) in (float, int):
            points[str(pid)] = score
    if not points:
        raise RuntimeError("Final player points are not available yet.")
    manager_points = None
    try:
        history = fetch(f"entry/{entry_id}/history/", 600)
        row = next((v for v in history.get("current", []) if v.get("event") == gameweek), None)
        if row and type(row.get("points")) in (float, int):
            manager_points = row["points"]
    except RuntimeError:
        pass
    return {"gameweek": gameweek, "final": True, "points": points,
            "manager_points": manager_points,
            "verified_at": datetime.now(timezone.utc).isoformat()}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, content, mime="application/json; charset=utf-8"):
        body = content if isinstance(content, bytes) else content.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/api/gw-results":
            qs = parse_qs(url.query)
            entry_str = qs.get("entry", [str(DEFAULT_TEAM_ID)])[0]
            gw_str = qs.get("gw", [""])[0]
            if not re.fullmatch(r"[1-9][0-9]{0,9}", entry_str) or not re.fullmatch(r"(?:[1-9]|[1-3][0-9])", gw_str):
                self._send(400, json.dumps({"error": "Invalid team or gameweek number."}))
                return
            if qs.get("demo", ["0"])[0] == "1":
                self._send(200, json.dumps({"gameweek": int(gw_str), "final": False,
                                            "reason": "Demo mode does not provide real match results."}))
                return
            try:
                self._send(200, json.dumps(gameweek_results(int(entry_str), int(gw_str)), separators=(",", ":")))
            except ValueError as ex:
                self._send(400, json.dumps({"error": str(ex)}))
            except RuntimeError as ex:
                self._send(502, json.dumps({"error": str(ex)}))
            return
        if url.path == "/api/data":
            qs = parse_qs(url.query)
            if qs.get("demo", ["0"])[0] == "1":
                self._send(200, (ROOT / "demo.json").read_bytes())
                return
            entry_str = qs.get("entry", [str(DEFAULT_TEAM_ID)])[0]
            if not re.fullmatch(r"[1-9][0-9]{0,9}", entry_str):
                self._send(400, json.dumps({"error": "Enter a numeric FPL team ID."}))
                return
            try:
                data = build_data(int(entry_str))
                self._send(200, json.dumps(data, separators=(",", ":")))
            except RuntimeError as ex:
                self._send(502, json.dumps({"error": str(ex)}))
            except Exception:
                self._send(500, json.dumps({"error": "Unexpected server error. Try again or see the terminal for details."}))
                raise
            return
        paths = {"/": "index.html", "/index.html": "index.html", "/app.js": "app.js", "/styles.css": "styles.css", "/manifest.webmanifest": "manifest.webmanifest", "/sw.js": "sw.js", "/icon-192.png": "icon-192.png", "/icon-512.png": "icon-512.png"}
        if url.path in paths:
            target = ROOT / paths[url.path]
            mime = {".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".webmanifest": "application/manifest+json", ".png": "image/png"}.get(target.suffix, "application/octet-stream")
            self._send(200, target.read_bytes(), mime)
        else:
            self._send(404, "Not found", "text/plain; charset=utf-8")

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args))


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8765"))
    httpd = ThreadingHTTPServer(("0.0.0.0" if os.environ.get("PORT") else "127.0.0.1", port), Handler)
    print(f"FPL AI Manager ready: http://localhost:{port}  (Team {DEFAULT_TEAM_ID})")
    print("Read-only: no FPL password required. Ctrl+C to stop.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
    finally:
        httpd.server_close()
