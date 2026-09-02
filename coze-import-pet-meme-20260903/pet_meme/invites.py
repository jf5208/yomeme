import hashlib
import secrets
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable


SUPPORTED_PROVIDERS = {"gemini", "seedream"}
CREDIT_COSTS = {"seedream": 1, "gemini": 3}
EVENT_STATUSES = {"reserved", "succeeded", "failed"}
RESERVATION_TTL = timedelta(minutes=10)


class InviteCodeError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class CreatedInvite:
    id: int
    plaintext_code: str
    code_hint: str
    provider: str
    remaining_uses: int
    enabled: bool


@dataclass(frozen=True)
class InviteStatus:
    id: int
    code_hint: str
    provider: str
    remaining_uses: int
    reserved_uses: int
    successful_uses: int
    enabled: bool


class InviteStore:
    def __init__(self, database_path: Path, now: Callable[[], datetime] | None = None):
        self.database_path = Path(database_path)
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self.now = now or (lambda: datetime.now(timezone.utc))
        self._initialize()

    def create_invite(self, provider: str = "seedream", uses: int = 1) -> CreatedInvite:
        self._validate_provider(provider)
        if not isinstance(uses, int) or uses < 1:
            raise InviteCodeError("invalid_uses", "积分必须是大于 0 的整数。")

        plaintext = secrets.token_urlsafe(18)
        digest = self._hash_code(plaintext)
        hint = f"{plaintext[:4]}...{plaintext[-4:]}"
        with self._connect() as connection:
            cursor = connection.execute(
                """
                INSERT INTO invite_codes
                  (code_hash, code_hint, provider, remaining_uses, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (digest, hint, provider, uses, self.now().isoformat()),
            )
        return CreatedInvite(cursor.lastrowid, plaintext, hint, provider, uses, True)

    def verify(self, code: str) -> InviteStatus:
        with self._connect() as connection:
            self._recover_stale_reservations(connection)
            row = self._lookup_code(connection, code)
            self._ensure_available(row, CREDIT_COSTS[row["provider"]])
            return self._status_from_row(row)

    def reserve(
        self,
        code: str,
        request_id: str,
        model: str,
        has_adjustment: bool,
        aspect_ratio: str,
    ) -> InviteStatus:
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            self._recover_stale_reservations(connection)
            row = self._lookup_code(connection, code)
            credit_cost = CREDIT_COSTS[row["provider"]]
            self._ensure_available(row, credit_cost)

            timestamp = self.now().isoformat()
            connection.execute(
                """
                UPDATE invite_codes
                SET remaining_uses = remaining_uses - ?,
                    reserved_uses = ?,
                    reserved_at = ?
                WHERE id = ?
                """,
                (credit_cost, credit_cost, timestamp, row["id"]),
            )
            connection.execute(
                """
                INSERT INTO generation_events
                  (request_id, created_at, access_method, provider, model,
                   invite_code_id, status, has_adjustment, aspect_ratio)
                VALUES (?, ?, 'invite', ?, ?, ?, 'reserved', ?, ?)
                """,
                (
                    request_id,
                    timestamp,
                    row["provider"],
                    model,
                    row["id"],
                    int(has_adjustment),
                    aspect_ratio,
                ),
            )
            return self._status_by_id(connection, row["id"])

    def complete(self, request_id: str) -> InviteStatus:
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            event = self._reserved_event(connection, request_id)
            connection.execute(
                "UPDATE generation_events SET status = 'succeeded' WHERE request_id = ?",
                (request_id,),
            )
            connection.execute(
                """
                UPDATE invite_codes
                SET reserved_uses = 0,
                    reserved_at = NULL,
                    successful_uses = successful_uses + 1
                WHERE id = ?
                """,
                (event["invite_code_id"],),
            )
            return self._status_by_id(connection, event["invite_code_id"])

    def refund(self, request_id: str) -> InviteStatus:
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            event = self._reserved_event(connection, request_id)
            connection.execute(
                "UPDATE generation_events SET status = 'failed' WHERE request_id = ?",
                (request_id,),
            )
            connection.execute(
                """
                UPDATE invite_codes
                SET remaining_uses = remaining_uses + reserved_uses,
                    reserved_uses = 0,
                    reserved_at = NULL
                WHERE id = ?
                """,
                (event["invite_code_id"],),
            )
            return self._status_by_id(connection, event["invite_code_id"])

    def record_own_api(
        self,
        request_id: str,
        provider: str,
        model: str,
        status: str,
        has_adjustment: bool,
        aspect_ratio: str,
    ) -> None:
        self._validate_provider(provider)
        self._validate_event_status(status)
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO generation_events
                  (request_id, created_at, access_method, provider, model,
                   invite_code_id, status, has_adjustment, aspect_ratio)
                VALUES (?, ?, 'own_api', ?, ?, NULL, ?, ?, ?)
                """,
                (
                    request_id,
                    self.now().isoformat(),
                    provider,
                    model,
                    status,
                    int(has_adjustment),
                    aspect_ratio,
                ),
            )

    def list_invites(self) -> list[InviteStatus]:
        with self._connect() as connection:
            rows = connection.execute("SELECT * FROM invite_codes ORDER BY id").fetchall()
        return [self._status_from_row(row) for row in rows]

    def set_enabled(self, invite_id: int, enabled: bool) -> InviteStatus:
        with self._connect() as connection:
            connection.execute(
                "UPDATE invite_codes SET enabled = ? WHERE id = ?",
                (int(enabled), invite_id),
            )
            return self._status_by_id(connection, invite_id)

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path)
        connection.row_factory = sqlite3.Row
        return connection

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS invite_codes (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  code_hash TEXT NOT NULL UNIQUE,
                  code_hint TEXT NOT NULL,
                  provider TEXT NOT NULL CHECK (provider IN ('gemini', 'seedream')),
                  remaining_uses INTEGER NOT NULL,
                  reserved_uses INTEGER NOT NULL DEFAULT 0,
                  reserved_at TEXT,
                  successful_uses INTEGER NOT NULL DEFAULT 0,
                  enabled INTEGER NOT NULL DEFAULT 1,
                  created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS generation_events (
                  request_id TEXT PRIMARY KEY,
                  created_at TEXT NOT NULL,
                  access_method TEXT NOT NULL CHECK (access_method IN ('invite', 'own_api')),
                  provider TEXT NOT NULL,
                  model TEXT NOT NULL,
                  invite_code_id INTEGER,
                  status TEXT NOT NULL CHECK (status IN ('reserved', 'succeeded', 'failed')),
                  has_adjustment INTEGER NOT NULL,
                  aspect_ratio TEXT NOT NULL,
                  FOREIGN KEY (invite_code_id) REFERENCES invite_codes(id)
                );
                """
            )

    def _lookup_code(self, connection: sqlite3.Connection, code: str) -> sqlite3.Row:
        row = connection.execute(
            "SELECT * FROM invite_codes WHERE code_hash = ?",
            (self._hash_code(code),),
        ).fetchone()
        if row is None:
            raise InviteCodeError("unknown", "邀请码无效，请检查后重试。")
        return row

    def _ensure_available(self, row: sqlite3.Row, credit_cost: int = 1) -> None:
        if not row["enabled"]:
            raise InviteCodeError("disabled", "这个邀请码已暂停使用。")
        if row["reserved_uses"]:
            raise InviteCodeError("busy", "这个邀请码正在生成，请完成后再试。")
        if row["remaining_uses"] < credit_cost:
            raise InviteCodeError("exhausted", f"这个邀请码的剩余积分不足，本次需要 {credit_cost} 积分。")

    def _status_from_row(self, row: sqlite3.Row) -> InviteStatus:
        return InviteStatus(
            id=row["id"],
            code_hint=row["code_hint"],
            provider=row["provider"],
            remaining_uses=row["remaining_uses"],
            reserved_uses=row["reserved_uses"],
            successful_uses=row["successful_uses"],
            enabled=bool(row["enabled"]),
        )

    def _validate_provider(self, provider: str) -> None:
        if provider not in SUPPORTED_PROVIDERS:
            raise InviteCodeError("invalid_provider", "请选择 Gemini 或 Seedream。")

    def _validate_event_status(self, status: str) -> None:
        if status not in EVENT_STATUSES:
            raise InviteCodeError("invalid_status", "生成状态无效。")

    def _hash_code(self, code: str) -> str:
        return hashlib.sha256(code.encode("utf-8")).hexdigest()

    def _status_by_id(self, connection: sqlite3.Connection, invite_id: int) -> InviteStatus:
        row = connection.execute("SELECT * FROM invite_codes WHERE id = ?", (invite_id,)).fetchone()
        if row is None:
            raise InviteCodeError("unknown", "邀请码无效，请检查后重试。")
        return self._status_from_row(row)

    def _reserved_event(self, connection: sqlite3.Connection, request_id: str) -> sqlite3.Row:
        event = connection.execute(
            """
            SELECT * FROM generation_events
            WHERE request_id = ? AND access_method = 'invite' AND status = 'reserved'
            """,
            (request_id,),
        ).fetchone()
        if event is None:
            raise InviteCodeError("unknown_request", "没有找到正在生成的请求。")
        return event

    def _recover_stale_reservations(self, connection: sqlite3.Connection) -> None:
        cutoff = self.now() - RESERVATION_TTL
        rows = connection.execute(
            """
            SELECT id, reserved_uses, reserved_at
            FROM invite_codes
            WHERE reserved_uses > 0 AND reserved_at IS NOT NULL
            """
        ).fetchall()
        for row in rows:
            reserved_at = datetime.fromisoformat(row["reserved_at"])
            if reserved_at >= cutoff:
                continue
            connection.execute(
                """
                UPDATE generation_events
                SET status = 'failed'
                WHERE invite_code_id = ? AND status = 'reserved'
                """,
                (row["id"],),
            )
            connection.execute(
                """
                UPDATE invite_codes
                SET remaining_uses = remaining_uses + reserved_uses,
                    reserved_uses = 0,
                    reserved_at = NULL
                WHERE id = ?
                """,
                (row["id"],),
            )
