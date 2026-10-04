#!/usr/bin/env python3
"""Wiezer: freezer inventory add-on for Home Assistant.

A small HTTP server (Python standard library only) that is reached through
Home Assistant ingress. Data is kept in an SQLite database in /data, which is
included in Home Assistant backups.

Amounts and step sizes are stored as whole numbers in tenths (1.5 -> 15) so
that one decimal place never produces rounding errors.
"""

import datetime
import json
import os
import re
import secrets
import sqlite3
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

VERSION = "0.2.0"

DATA_DIR = os.environ.get("WIEZER_DATA", "/data")
DB_PATH = os.path.join(DATA_DIR, "wiezer.db")
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
PORT = int(os.environ.get("WIEZER_PORT", "8099"))
# Only the Supervisor's ingress proxy may talk to us (unless in local dev mode)
DEV_MODE = os.environ.get("WIEZER_DEV") == "1"
INGRESS_IP = "172.30.32.2"

SCHEMA_VERSION = 1
MAX_AMOUNT = 10_000_000  # 1,000,000.0 in tenths
MAX_NAME = 100
MAX_NOTE = 500
MAX_BODY = 64 * 1024
UNDO_SECONDS = 120
ITEM_COLUMNS = ("name", "drawer_id", "unit_id", "amount", "added", "note", "created_by", "created_at", "updated_at")

DEFAULT_DRAWERS = ["1", "2", "3", "4", "5", "6", "7"]
# builtin key, step (tenths), decimals allowed
DEFAULT_UNITS = [
    ("g", 1000, 0),
    ("piece", 10, 0),
    ("portion", 10, 1),
    ("slice", 10, 0),
    ("package", 10, 1),
]

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
}

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class ApiError(Exception):
    """An error reported to the client as {"error": code}; the client translates the code."""

    def __init__(self, code, status=400):
        super().__init__(code)
        self.code = code
        self.status = status


def now_iso():
    return datetime.datetime.now().isoformat(timespec="seconds")


def catalog_key(name):
    return " ".join(name.split()).casefold()


# ----------------------------------------------------------------------------- database


class Store:
    def __init__(self, path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys = ON")
        self.lock = threading.Lock()
        self.undo = {}  # token -> {"expires", "before", "after"}; kept in memory only
        with self.lock:
            self._migrate()

    def _migrate(self):
        db = self.db
        db.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        row = db.execute("SELECT value FROM meta WHERE key = 'schema'").fetchone()
        version = int(row["value"]) if row else 0
        if version < 1:
            db.executescript(
                """
                CREATE TABLE groups (
                    id INTEGER PRIMARY KEY,
                    name TEXT NOT NULL,
                    position INTEGER NOT NULL
                );
                CREATE TABLE drawers (
                    id INTEGER PRIMARY KEY,
                    name TEXT NOT NULL,
                    group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
                    position INTEGER NOT NULL
                );
                CREATE TABLE units (
                    id INTEGER PRIMARY KEY,
                    builtin TEXT,
                    singular TEXT,
                    plural TEXT,
                    step INTEGER NOT NULL,
                    decimals INTEGER NOT NULL,
                    position INTEGER NOT NULL
                );
                CREATE TABLE items (
                    id INTEGER PRIMARY KEY,
                    name TEXT NOT NULL,
                    drawer_id INTEGER NOT NULL REFERENCES drawers(id),
                    unit_id INTEGER NOT NULL REFERENCES units(id),
                    amount INTEGER NOT NULL,
                    added TEXT NOT NULL,
                    note TEXT NOT NULL DEFAULT '',
                    created_by TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE catalog (
                    key TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    unit_id INTEGER,
                    drawer_id INTEGER,
                    amount INTEGER,
                    uses INTEGER NOT NULL DEFAULT 0,
                    last_used TEXT NOT NULL
                );
                CREATE TABLE user_settings (
                    user_id TEXT PRIMARY KEY,
                    language TEXT NOT NULL DEFAULT 'system',
                    theme TEXT NOT NULL DEFAULT 'system'
                );
                """
            )
            for pos, name in enumerate(DEFAULT_DRAWERS):
                db.execute("INSERT INTO drawers (name, position) VALUES (?, ?)", (name, pos))
            for pos, (key, step, decimals) in enumerate(DEFAULT_UNITS):
                db.execute(
                    "INSERT INTO units (builtin, step, decimals, position) VALUES (?, ?, ?, ?)",
                    (key, step, decimals, pos),
                )
            db.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('rev', '1')")
        db.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', ?)", (str(SCHEMA_VERSION),))
        db.commit()

    # --- helpers

    def rev(self):
        return int(self.db.execute("SELECT value FROM meta WHERE key = 'rev'").fetchone()["value"])

    def _bump(self):
        self.db.execute("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'rev'")

    def _exists(self, table, row_id):
        return self.db.execute(f"SELECT 1 FROM {table} WHERE id = ?", (row_id,)).fetchone() is not None

    def _next_pos(self, table):
        row = self.db.execute(f"SELECT COALESCE(MAX(position), -1) + 1 AS p FROM {table}").fetchone()
        return row["p"]

    def _move(self, table, row_id, direction):
        rows = [r["id"] for r in self.db.execute(f"SELECT id FROM {table} ORDER BY position, id")]
        if row_id not in rows:
            raise ApiError("not_found", 404)
        i = rows.index(row_id)
        j = i + (1 if direction > 0 else -1)
        if 0 <= j < len(rows):
            rows[i], rows[j] = rows[j], rows[i]
            for pos, rid in enumerate(rows):
                self.db.execute(f"UPDATE {table} SET position = ? WHERE id = ?", (pos, rid))

    def _touch_catalog(self, name, unit_id, drawer_id, amount, count_use):
        key = catalog_key(name)
        stamp = now_iso()
        row = self.db.execute("SELECT key FROM catalog WHERE key = ?", (key,)).fetchone()
        if row:
            self.db.execute(
                "UPDATE catalog SET name = ?, unit_id = ?, drawer_id = ?, amount = ?,"
                " uses = uses + ?, last_used = ? WHERE key = ?",
                (name, unit_id, drawer_id, amount, 1 if count_use else 0, stamp, key),
            )
        else:
            self.db.execute(
                "INSERT INTO catalog (key, name, unit_id, drawer_id, amount, uses, last_used)"
                " VALUES (?, ?, ?, ?, ?, ?, ?)",
                (key, name, unit_id, drawer_id, amount, 1, stamp),
            )

    # --- reads

    def state(self, user):
        db = self.db
        settings = db.execute(
            "SELECT language, theme FROM user_settings WHERE user_id = ?", (user["id"] or "_default",)
        ).fetchone()
        return {
            "version": VERSION,
            "rev": self.rev(),
            "user": {"name": user["name"]},
            "settings": dict(settings) if settings else {"language": "system", "theme": "system"},
            "groups": [dict(r) for r in db.execute("SELECT id, name FROM groups ORDER BY position, id")],
            "drawers": [
                dict(r) for r in db.execute("SELECT id, name, group_id FROM drawers ORDER BY position, id")
            ],
            "units": [
                dict(r, decimals=bool(r["decimals"]))
                for r in db.execute(
                    "SELECT id, builtin, singular, plural, step, decimals FROM units ORDER BY position, id"
                )
            ],
            "items": [
                dict(r)
                for r in db.execute(
                    "SELECT id, name, drawer_id, unit_id, amount, added, note, created_by"
                    " FROM items ORDER BY added, id"
                )
            ],
            "catalog": [
                dict(r)
                for r in db.execute(
                    "SELECT name, unit_id, drawer_id, amount, uses FROM catalog ORDER BY uses DESC, last_used DESC"
                )
            ],
        }

    # --- writes (all called with the lock held, commit by caller)

    def save_settings(self, user, body):
        language = body.get("language", "system")
        theme = body.get("theme", "system")
        if language not in ("system", "de", "en") or theme not in ("system", "light", "dark"):
            raise ApiError("invalid")
        self.db.execute(
            "INSERT INTO user_settings (user_id, language, theme) VALUES (?, ?, ?)"
            " ON CONFLICT(user_id) DO UPDATE SET language = excluded.language, theme = excluded.theme",
            (user["id"] or "_default", language, theme),
        )

    def _item_fields(self, body, partial):
        fields = {}
        if "name" in body or not partial:
            fields["name"] = clean_text(body.get("name"), MAX_NAME, required=True)
        if "drawer_id" in body or not partial:
            drawer_id = as_int(body.get("drawer_id"))
            if not self._exists("drawers", drawer_id):
                raise ApiError("invalid")
            fields["drawer_id"] = drawer_id
        if "unit_id" in body or not partial:
            unit_id = as_int(body.get("unit_id"))
            if not self._exists("units", unit_id):
                raise ApiError("invalid")
            fields["unit_id"] = unit_id
        if "amount" in body or not partial:
            amount = as_int(body.get("amount"))
            if not 0 < amount <= MAX_AMOUNT:
                raise ApiError("invalid")
            fields["amount"] = amount
        if "added" in body or not partial:
            added = body.get("added") or datetime.date.today().isoformat()
            if not isinstance(added, str) or not DATE_RE.match(added):
                raise ApiError("invalid")
            try:
                datetime.date.fromisoformat(added)
            except ValueError:
                raise ApiError("invalid") from None
            fields["added"] = added
        if "note" in body or not partial:
            fields["note"] = clean_text(body.get("note", ""), MAX_NOTE, required=False, multiline=True)
        return fields

    def add_item(self, user, body):
        f = self._item_fields(body, partial=False)
        stamp = now_iso()
        cur = self.db.execute(
            "INSERT INTO items (name, drawer_id, unit_id, amount, added, note, created_by, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (f["name"], f["drawer_id"], f["unit_id"], f["amount"], f["added"], f["note"], user["name"], stamp, stamp),
        )
        self._touch_catalog(f["name"], f["unit_id"], f["drawer_id"], f["amount"], count_use=True)
        return cur.lastrowid

    def edit_item(self, item_id, body):
        row = self.db.execute("SELECT * FROM items WHERE id = ?", (item_id,)).fetchone()
        if not row:
            raise ApiError("not_found", 404)
        f = self._item_fields(body, partial=True)
        if not f:
            return
        f["updated_at"] = now_iso()
        cols = ", ".join(f"{k} = ?" for k in f)
        self.db.execute(f"UPDATE items SET {cols} WHERE id = ?", (*f.values(), item_id))
        merged = {**dict(row), **f}
        self._touch_catalog(merged["name"], merged["unit_id"], merged["drawer_id"], merged["amount"], count_use=False)

    def take_item(self, item_id, body):
        row = self.db.execute("SELECT amount FROM items WHERE id = ?", (item_id,)).fetchone()
        if not row:
            raise ApiError("not_found", 404)
        amount = as_int(body.get("amount"))
        if amount <= 0:
            raise ApiError("invalid")
        if amount >= row["amount"]:
            self.db.execute("DELETE FROM items WHERE id = ?", (item_id,))
            return True
        self.db.execute(
            "UPDATE items SET amount = amount - ?, updated_at = ? WHERE id = ?", (amount, now_iso(), item_id)
        )
        return False

    def delete_item(self, item_id):
        if self.db.execute("DELETE FROM items WHERE id = ?", (item_id,)).rowcount == 0:
            raise ApiError("not_found", 404)

    def _row(self, item_id):
        row = self.db.execute("SELECT * FROM items WHERE id = ?", (item_id,)).fetchone()
        return dict(row) if row else None

    def _prune_undo(self):
        now = time.time()
        for token in [t for t, rec in self.undo.items() if rec["expires"] < now]:
            del self.undo[token]

    def move_item(self, item_id, body):
        """Move all or part of an entry to another drawer.

        A part becomes its own entry. If the target drawer already has an entry with
        the same name, unit and freezing date, the amount is added to it instead.
        Returns an undo token valid for UNDO_SECONDS.
        """
        src = self._row(item_id)
        if not src:
            raise ApiError("not_found", 404)
        drawer_id = as_int(body.get("drawer_id"))
        if drawer_id == src["drawer_id"] or not self._exists("drawers", drawer_id):
            raise ApiError("invalid")
        amount = as_int(body.get("amount", src["amount"]))
        if amount <= 0:
            raise ApiError("invalid")
        amount = min(amount, src["amount"])
        whole = amount == src["amount"]

        key = catalog_key(src["name"])
        target = None
        for row in self.db.execute(
            "SELECT * FROM items WHERE drawer_id = ? AND unit_id = ? AND added = ? AND id != ? ORDER BY id",
            (drawer_id, src["unit_id"], src["added"], item_id),
        ):
            if catalog_key(row["name"]) == key:
                target = dict(row)
                break

        before = {item_id: src}
        stamp = now_iso()
        if target:
            before[target["id"]] = target
            self.db.execute(
                "UPDATE items SET amount = amount + ?, updated_at = ? WHERE id = ?", (amount, stamp, target["id"])
            )
            if whole:
                self.db.execute("DELETE FROM items WHERE id = ?", (item_id,))
            else:
                self.db.execute(
                    "UPDATE items SET amount = amount - ?, updated_at = ? WHERE id = ?", (amount, stamp, item_id)
                )
            moved_id = target["id"]
        elif whole:
            self.db.execute("UPDATE items SET drawer_id = ?, updated_at = ? WHERE id = ?", (drawer_id, stamp, item_id))
            moved_id = item_id
        else:
            self.db.execute(
                "UPDATE items SET amount = amount - ?, updated_at = ? WHERE id = ?", (amount, stamp, item_id)
            )
            cur = self.db.execute(
                "INSERT INTO items (name, drawer_id, unit_id, amount, added, note, created_by, created_at, updated_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (src["name"], drawer_id, src["unit_id"], amount, src["added"], src["note"], src["created_by"],
                 stamp, stamp),
            )
            moved_id = cur.lastrowid
            before[moved_id] = None  # did not exist before: undo deletes it

        self._prune_undo()
        token = secrets.token_hex(12)
        self.undo[token] = {
            "expires": time.time() + UNDO_SECONDS,
            "before": before,
            "after": {i: self._row(i) for i in before},
        }
        return {"moved_id": moved_id, "merged": bool(target), "undo": token}

    def undo_move(self, body):
        token = body.get("token")
        self._prune_undo()
        record = self.undo.pop(token, None) if isinstance(token, str) else None
        if not record:
            raise ApiError("undo_expired", 409)
        # Only undo if nobody changed the affected entries in the meantime
        for item_id, expected in record["after"].items():
            if self._row(item_id) != expected:
                raise ApiError("undo_expired", 409)
        for item_id, snapshot in record["before"].items():
            if snapshot is None:
                self.db.execute("DELETE FROM items WHERE id = ?", (item_id,))
            elif self._row(item_id):
                cols = ", ".join(f"{c} = ?" for c in ITEM_COLUMNS)
                self.db.execute(
                    f"UPDATE items SET {cols} WHERE id = ?", (*(snapshot[c] for c in ITEM_COLUMNS), item_id)
                )
            else:
                cols = ", ".join(("id",) + ITEM_COLUMNS)
                marks = ", ".join("?" * (len(ITEM_COLUMNS) + 1))
                self.db.execute(
                    f"INSERT INTO items ({cols}) VALUES ({marks})", (item_id, *(snapshot[c] for c in ITEM_COLUMNS))
                )

    def add_group(self, body):
        name = clean_text(body.get("name"), MAX_NAME, required=True)
        self.db.execute("INSERT INTO groups (name, position) VALUES (?, ?)", (name, self._next_pos("groups")))

    def edit_group(self, group_id, body):
        name = clean_text(body.get("name"), MAX_NAME, required=True)
        if self.db.execute("UPDATE groups SET name = ? WHERE id = ?", (name, group_id)).rowcount == 0:
            raise ApiError("not_found", 404)

    def delete_group(self, group_id):
        # Drawers of the group stay; they just lose their group
        self.db.execute("UPDATE drawers SET group_id = NULL WHERE group_id = ?", (group_id,))
        if self.db.execute("DELETE FROM groups WHERE id = ?", (group_id,)).rowcount == 0:
            raise ApiError("not_found", 404)

    def _group_ref(self, body):
        group_id = body.get("group_id")
        if group_id is None:
            return None
        group_id = as_int(group_id)
        if not self._exists("groups", group_id):
            raise ApiError("invalid")
        return group_id

    def add_drawer(self, body):
        name = clean_text(body.get("name"), MAX_NAME, required=True)
        self.db.execute(
            "INSERT INTO drawers (name, group_id, position) VALUES (?, ?, ?)",
            (name, self._group_ref(body), self._next_pos("drawers")),
        )

    def edit_drawer(self, drawer_id, body):
        if not self._exists("drawers", drawer_id):
            raise ApiError("not_found", 404)
        if "name" in body:
            name = clean_text(body.get("name"), MAX_NAME, required=True)
            self.db.execute("UPDATE drawers SET name = ? WHERE id = ?", (name, drawer_id))
        if "group_id" in body:
            self.db.execute("UPDATE drawers SET group_id = ? WHERE id = ?", (self._group_ref(body), drawer_id))

    def delete_drawer(self, drawer_id):
        if not self._exists("drawers", drawer_id):
            raise ApiError("not_found", 404)
        if self.db.execute("SELECT 1 FROM items WHERE drawer_id = ?", (drawer_id,)).fetchone():
            raise ApiError("drawer_not_empty", 409)
        if self.db.execute("SELECT COUNT(*) AS n FROM drawers").fetchone()["n"] <= 1:
            raise ApiError("last_drawer", 409)
        self.db.execute("UPDATE catalog SET drawer_id = NULL WHERE drawer_id = ?", (drawer_id,))
        self.db.execute("DELETE FROM drawers WHERE id = ?", (drawer_id,))

    def _unit_fields(self, body, partial):
        fields = {}
        if "singular" in body:
            # Renaming a built-in unit turns it into a custom unit (no longer translated)
            fields["singular"] = clean_text(body.get("singular"), MAX_NAME, required=True)
            plural = clean_text(body.get("plural", ""), MAX_NAME, required=False)
            fields["plural"] = plural or None
            fields["builtin"] = None
        elif not partial:
            raise ApiError("invalid")
        if "step" in body or not partial:
            step = as_int(body.get("step"))
            if not 0 < step <= MAX_AMOUNT:
                raise ApiError("invalid")
            fields["step"] = step
        if "decimals" in body or not partial:
            fields["decimals"] = 1 if body.get("decimals") else 0
        if fields.get("decimals") == 0 and "step" in fields and fields["step"] % 10:
            raise ApiError("invalid")
        return fields

    def add_unit(self, body):
        f = self._unit_fields(body, partial=False)
        self.db.execute(
            "INSERT INTO units (builtin, singular, plural, step, decimals, position) VALUES (NULL, ?, ?, ?, ?, ?)",
            (f["singular"], f["plural"], f["step"], f["decimals"], self._next_pos("units")),
        )

    def edit_unit(self, unit_id, body):
        row = self.db.execute("SELECT * FROM units WHERE id = ?", (unit_id,)).fetchone()
        if not row:
            raise ApiError("not_found", 404)
        f = self._unit_fields(body, partial=True)
        merged = {**dict(row), **f}
        if not merged["decimals"] and merged["step"] % 10:
            raise ApiError("invalid")
        if f:
            cols = ", ".join(f"{k} = ?" for k in f)
            self.db.execute(f"UPDATE units SET {cols} WHERE id = ?", (*f.values(), unit_id))

    def delete_unit(self, unit_id):
        if not self._exists("units", unit_id):
            raise ApiError("not_found", 404)
        if self.db.execute("SELECT 1 FROM items WHERE unit_id = ?", (unit_id,)).fetchone():
            raise ApiError("unit_in_use", 409)
        if self.db.execute("SELECT COUNT(*) AS n FROM units").fetchone()["n"] <= 1:
            raise ApiError("last_unit", 409)
        self.db.execute("UPDATE catalog SET unit_id = NULL WHERE unit_id = ?", (unit_id,))
        self.db.execute("DELETE FROM units WHERE id = ?", (unit_id,))



def clean_text(value, max_len, required, multiline=False):
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise ApiError("invalid")
    value = value.strip() if multiline else " ".join(value.split())
    if required and not value:
        raise ApiError("invalid")
    if len(value) > max_len:
        raise ApiError("invalid")
    return value


def as_int(value):
    if isinstance(value, bool) or not isinstance(value, int):
        raise ApiError("invalid")
    return value


# ----------------------------------------------------------------------------- HTTP


STORE = None

# (method, pattern) -> handler name; <id> captures an integer
ROUTES = [
    ("GET", r"/api/state", "get_state"),
    ("GET", r"/api/rev", "get_rev"),
    ("PUT", r"/api/settings", "put_settings"),
    ("POST", r"/api/items", "post_item"),
    ("PATCH", r"/api/items/(\d+)", "patch_item"),
    ("DELETE", r"/api/items/(\d+)", "delete_item"),
    ("POST", r"/api/items/(\d+)/take", "take_item"),
    ("POST", r"/api/items/(\d+)/move", "move_item"),
    ("POST", r"/api/items/undo", "undo_move"),
    ("POST", r"/api/(groups|drawers|units)", "post_entity"),
    ("PATCH", r"/api/(groups|drawers|units)/(\d+)", "patch_entity"),
    ("DELETE", r"/api/(groups|drawers|units)/(\d+)", "delete_entity"),
    ("POST", r"/api/(groups|drawers|units)/(\d+)/move", "move_entity"),
]
ROUTES = [(m, re.compile(p + r"$"), h) for m, p, h in ROUTES]


class Handler(BaseHTTPRequestHandler):
    server_version = "Wiezer/" + VERSION
    protocol_version = "HTTP/1.1"

    # --- plumbing

    def log_message(self, fmt, *args):  # keep the add-on log quiet
        pass

    def _user(self):
        uid = self.headers.get("X-Remote-User-Id", "")
        name = (
            self.headers.get("X-Remote-User-Display-Name")
            or self.headers.get("X-Remote-User-Name")
            or ""
        )
        return {"id": uid, "name": name}

    def _send(self, status, body, content_type="application/json; charset=utf-8"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            raise ApiError("invalid", 413)
        if not length:
            return {}
        try:
            data = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise ApiError("invalid") from None
        if not isinstance(data, dict):
            raise ApiError("invalid")
        return data

    def _allowed(self, path):
        client = self.client_address[0]
        if DEV_MODE or client == INGRESS_IP:
            return True
        return path == "/healthz" and client == "127.0.0.1"

    def _dispatch(self):
        path = unquote(urlparse(self.path).path)
        if not self._allowed(path):
            self._send(403, {"error": "forbidden"})
            return
        if path == "/healthz":
            self._send(200, b"ok", "text/plain")
            return
        if path.startswith("/api/"):
            self._api(path)
            return
        if self.command in ("GET", "HEAD"):
            self._static(path)
            return
        self._send(405, {"error": "invalid"})

    do_GET = do_HEAD = do_POST = do_PUT = do_PATCH = do_DELETE = _dispatch

    # --- static files

    def _static(self, path):
        rel = "index.html" if path in ("", "/") else path.lstrip("/")
        full = os.path.realpath(os.path.join(STATIC_DIR, rel))
        if not full.startswith(os.path.realpath(STATIC_DIR) + os.sep) or not os.path.isfile(full):
            self._send(404, b"not found", "text/plain")
            return
        with open(full, "rb") as fh:
            data = fh.read()
        ext = os.path.splitext(full)[1]
        self._send(200, data, CONTENT_TYPES.get(ext, "application/octet-stream"))

    # --- API

    def _api(self, path):
        for method, pattern, handler in ROUTES:
            match = pattern.match(path)
            if match and method == self.command:
                break
        else:
            self._send(404, {"error": "not_found"})
            return
        user = self._user()
        try:
            body = self._body() if self.command in ("POST", "PUT", "PATCH") else {}
            with STORE.lock:
                try:
                    extra = getattr(self, "h_" + handler)(user, body, *match.groups())
                    if self.command != "GET":
                        STORE._bump()
                        STORE.db.commit()
                except Exception:
                    STORE.db.rollback()
                    raise
                if handler == "get_rev":
                    result = {"rev": STORE.rev()}
                else:
                    result = STORE.state(user)
                    if extra:
                        result.update(extra)
            self._send(200, result)
        except ApiError as err:
            self._send(err.status, {"error": err.code})
        except sqlite3.Error as err:
            print(f"Database error: {err}", flush=True)
            self._send(500, {"error": "server"})

    def h_get_state(self, user, body):
        return None

    def h_get_rev(self, user, body):
        return None

    def h_put_settings(self, user, body):
        STORE.save_settings(user, body)

    def h_post_item(self, user, body):
        return {"created_id": STORE.add_item(user, body)}

    def h_patch_item(self, user, body, item_id):
        STORE.edit_item(int(item_id), body)

    def h_delete_item(self, user, body, item_id):
        STORE.delete_item(int(item_id))

    def h_move_item(self, user, body, item_id):
        return STORE.move_item(int(item_id), body)

    def h_undo_move(self, user, body):
        STORE.undo_move(body)

    def h_take_item(self, user, body, item_id):
        return {"removed": STORE.take_item(int(item_id), body)}

    def h_post_entity(self, user, body, kind):
        {"groups": STORE.add_group, "drawers": STORE.add_drawer, "units": STORE.add_unit}[kind](body)

    def h_patch_entity(self, user, body, kind, row_id):
        {"groups": STORE.edit_group, "drawers": STORE.edit_drawer, "units": STORE.edit_unit}[kind](int(row_id), body)

    def h_delete_entity(self, user, body, kind, row_id):
        {"groups": STORE.delete_group, "drawers": STORE.delete_drawer, "units": STORE.delete_unit}[kind](int(row_id))

    def h_move_entity(self, user, body, kind, row_id):
        direction = body.get("direction")
        if direction not in (-1, 1):
            raise ApiError("invalid")
        STORE._move(kind, int(row_id), direction)


def main():
    global STORE
    STORE = Store(DB_PATH)
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    print(f"Wiezer {VERSION} listening on port {PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
