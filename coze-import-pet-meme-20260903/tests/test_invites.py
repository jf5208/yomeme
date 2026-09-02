import hashlib
import sqlite3
from datetime import datetime, timedelta, timezone

import pytest

from pet_meme.invites import InviteCodeError, InviteStore


class MutableClock:
    def __init__(self, current):
        self.current = current

    def now(self):
        return self.current

    def advance(self, minutes):
        self.current += timedelta(minutes=minutes)


def test_create_invite_stores_hash_and_returns_plaintext_once(tmp_path):
    store = InviteStore(tmp_path / "pet-meme.sqlite3")
    created = store.create_invite(provider="seedream", uses=3)

    assert created.plaintext_code
    assert created.code_hint.startswith(created.plaintext_code[:4])
    assert store.verify(created.plaintext_code).remaining_uses == 3

    with sqlite3.connect(tmp_path / "pet-meme.sqlite3") as connection:
        row = connection.execute("SELECT code_hash, code_hint FROM invite_codes").fetchone()
    assert created.plaintext_code not in row
    assert row[0] == hashlib.sha256(created.plaintext_code.encode()).hexdigest()


@pytest.mark.parametrize("provider", ["gemini", "seedream"])
def test_create_invite_accepts_supported_provider(tmp_path, provider):
    created = InviteStore(tmp_path / "pet-meme.sqlite3").create_invite(provider, 2)
    assert created.provider == provider


@pytest.mark.parametrize(
    ("provider", "uses", "error_code", "message"),
    [
        ("unknown", 1, "invalid_provider", "请选择 Gemini 或 Seedream。"),
        ("seedream", 0, "invalid_uses", "积分必须是大于 0 的整数。"),
    ],
)
def test_create_invite_rejects_invalid_inputs(tmp_path, provider, uses, error_code, message):
    store = InviteStore(tmp_path / "pet-meme.sqlite3")

    with pytest.raises(InviteCodeError, match=message) as error:
        store.create_invite(provider, uses)

    assert error.value.code == error_code


def test_reserve_holds_one_use_and_records_event(tmp_path):
    store = InviteStore(tmp_path / "pet-meme.sqlite3")
    code = store.create_invite("seedream", 2).plaintext_code

    status = store.reserve(code, "req-0", "seedream-model", False, "1:1")

    assert (status.remaining_uses, status.reserved_uses, status.successful_uses) == (1, 1, 0)
    with sqlite3.connect(tmp_path / "pet-meme.sqlite3") as connection:
        row = connection.execute(
            """
            SELECT access_method, provider, model, invite_code_id, status, has_adjustment, aspect_ratio
            FROM generation_events WHERE request_id = 'req-0'
            """
        ).fetchone()
    assert row == ("invite", "seedream", "seedream-model", 1, "reserved", 0, "1:1")


def test_complete_consumes_one_reserved_use(tmp_path):
    store = InviteStore(tmp_path / "pet-meme.sqlite3")
    code = store.create_invite("seedream", 2).plaintext_code
    store.reserve(code, "req-1", "seedream-model", False, "1:1")

    status = store.complete("req-1")

    assert (status.remaining_uses, status.reserved_uses, status.successful_uses) == (1, 0, 1)


def test_gemini_generation_reserves_three_credits_and_refunds_three(tmp_path):
    store = InviteStore(tmp_path / "pet-meme.sqlite3")
    invite = store.create_invite(provider="gemini", uses=10)

    reserved = store.reserve(invite.plaintext_code, "req-gemini", "gemini-model", False, "1:1")

    assert (reserved.remaining_uses, reserved.reserved_uses) == (7, 3)

    refunded = store.refund("req-gemini")

    assert (refunded.remaining_uses, refunded.reserved_uses) == (10, 0)


def test_refund_restores_reserved_use(tmp_path):
    store = InviteStore(tmp_path / "pet-meme.sqlite3")
    code = store.create_invite("gemini", 10).plaintext_code
    store.reserve(code, "req-1", "gemini-model", True, "4:5")

    status = store.refund("req-1")

    assert (status.remaining_uses, status.reserved_uses, status.successful_uses) == (10, 0, 0)


def test_second_reservation_is_rejected_while_first_is_active(tmp_path):
    store = InviteStore(tmp_path / "pet-meme.sqlite3")
    code = store.create_invite("seedream", 2).plaintext_code
    store.reserve(code, "req-1", "model", False, "1:1")

    with pytest.raises(InviteCodeError, match="正在生成"):
        store.reserve(code, "req-2", "model", False, "1:1")


def test_verify_rejects_active_reservation_as_busy(tmp_path):
    store = InviteStore(tmp_path / "pet-meme.sqlite3")
    code = store.create_invite("seedream", 2).plaintext_code
    store.reserve(code, "req-1", "model", False, "1:1")

    with pytest.raises(InviteCodeError, match="正在生成"):
        store.verify(code)


def test_stale_reservation_is_refunded_before_verify(tmp_path):
    clock = MutableClock(datetime(2026, 9, 2, tzinfo=timezone.utc))
    store = InviteStore(tmp_path / "pet-meme.sqlite3", now=clock.now)
    code = store.create_invite("seedream", 1).plaintext_code
    store.reserve(code, "req-1", "model", False, "1:1")

    clock.advance(minutes=11)
    status = store.verify(code)

    assert (status.remaining_uses, status.reserved_uses) == (1, 0)
    with sqlite3.connect(tmp_path / "pet-meme.sqlite3") as connection:
        event_status = connection.execute(
            "SELECT status FROM generation_events WHERE request_id = 'req-1'"
        ).fetchone()[0]
    assert event_status == "failed"


def test_exactly_ten_minute_reservation_is_still_busy(tmp_path):
    clock = MutableClock(datetime(2026, 9, 2, tzinfo=timezone.utc))
    store = InviteStore(tmp_path / "pet-meme.sqlite3", now=clock.now)
    code = store.create_invite("seedream", 1).plaintext_code
    store.reserve(code, "req-1", "model", False, "1:1")

    clock.advance(minutes=10)

    with pytest.raises(InviteCodeError, match="正在生成"):
        store.verify(code)


def test_unknown_disabled_and_exhausted_codes_have_distinct_errors(tmp_path):
    store = InviteStore(tmp_path / "pet-meme.sqlite3")

    with pytest.raises(InviteCodeError, match="邀请码无效"):
        store.verify("not-a-code")

    disabled = store.create_invite("seedream", 1)
    disabled_status = store.set_enabled(disabled.id, False)
    assert disabled_status.enabled is False
    with pytest.raises(InviteCodeError, match="暂停"):
        store.verify(disabled.plaintext_code)

    exhausted = store.create_invite("seedream", 1)
    store.reserve(exhausted.plaintext_code, "req-2", "model", False, "1:1")
    store.complete("req-2")
    with pytest.raises(InviteCodeError, match="剩余积分不足"):
        store.verify(exhausted.plaintext_code)


def test_generation_event_moves_from_reserved_to_failed_on_refund(tmp_path):
    store = InviteStore(tmp_path / "pet-meme.sqlite3")
    code = store.create_invite("seedream", 1).plaintext_code
    store.reserve(code, "req-3", "model", False, "1:1")

    store.refund("req-3")

    with sqlite3.connect(tmp_path / "pet-meme.sqlite3") as connection:
        status = connection.execute(
            "SELECT status FROM generation_events WHERE request_id = 'req-3'"
        ).fetchone()[0]
    assert status == "failed"


def test_list_invites_returns_statuses_in_creation_order(tmp_path):
    store = InviteStore(tmp_path / "pet-meme.sqlite3")
    first = store.create_invite("gemini", 1)
    second = store.create_invite("seedream", 2)

    statuses = store.list_invites()

    assert [status.id for status in statuses] == [first.id, second.id]
    assert [status.provider for status in statuses] == ["gemini", "seedream"]
    assert [status.remaining_uses for status in statuses] == [1, 2]


def test_record_own_api_writes_event_without_invite_or_key(tmp_path):
    store = InviteStore(tmp_path / "pet-meme.sqlite3")

    store.record_own_api("req-own", "gemini", "gemini-model", "succeeded", True, "9:16")

    with sqlite3.connect(tmp_path / "pet-meme.sqlite3") as connection:
        row = connection.execute(
            """
            SELECT access_method, provider, model, invite_code_id, status, has_adjustment, aspect_ratio
            FROM generation_events WHERE request_id = 'req-own'
            """
        ).fetchone()
    assert row == ("own_api", "gemini", "gemini-model", None, "succeeded", 1, "9:16")
