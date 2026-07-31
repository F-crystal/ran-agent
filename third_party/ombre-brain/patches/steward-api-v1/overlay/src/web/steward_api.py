"""Loopback-only, fail-closed ran-agent Steward API for the pinned Ombre runner."""

from __future__ import annotations

import hashlib
import hmac
import asyncio
import json
import os
import re
import stat
from datetime import datetime, timezone
from pathlib import Path

from starlette.requests import Request
from starlette.responses import JSONResponse

from . import _shared as sh


API_VERSION = "ombre.steward-api/1"
RECEIPT_VERSION = "ombre.steward-receipt/1"
PROTOCOL_ID = "ombre-stewarded-growth-compatibility/6"
TOKEN_HEADER = "X-Ran-Agent-Steward-Token"
MUTATIONS = {
    "append_experience",
    "append_association",
    "append_low_impact_preference_observation",
    "append_i_observation_candidate",
    "append_correction_or_supersession_observation",
    "suppress",
    "tombstone",
    "total_delete",
}
READS = {"reconcile_operation", "get_operation_receipt", "get_target_revision"}
METHODS = MUTATIONS | READS
APPENDS = {
    "append_experience": "experience",
    "append_association": "association",
    "append_low_impact_preference_observation": "preference-observation",
    "append_i_observation_candidate": "i-observation-candidate",
    "append_correction_or_supersession_observation": "correction-observation",
}
SHA256 = re.compile(r"^sha256:[a-f0-9]{64}$")
ATTEMPT_ID = re.compile(r"^ocq_attempt_[a-f0-9]{24}$")
SOURCE_ID = re.compile(r"^ocq_src_[a-f0-9]{32}$")
TARGET_REF = re.compile(
    r"^ombre-steward://target/"
    r"(experience|association|preference-observation|i-observation-candidate|correction-observation)/"
    r"([a-z0-9][a-z0-9_-]{0,127})$"
)
LIFECYCLE_REF = re.compile(r"^compat-lifecycle://event/[A-Za-z0-9_-]{1,128}/revision/(0|[1-9][0-9]*)$")
_LOCK = asyncio.Lock()


class StewardError(Exception):
    def __init__(self, code: str, message: str, status: int = 400, retryable: bool = False):
        super().__init__(message)
        self.code, self.status, self.retryable = code, status, retryable


def _canonical(value) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def _digest(value) -> str:
    return "sha256:" + hashlib.sha256(_canonical(value)).hexdigest()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _strict(value, keys: set[str], label: str) -> None:
    if not isinstance(value, dict) or set(value) != keys:
        raise StewardError("STEWARD_SCHEMA_INVALID", f"{label} fields invalid")


def _identity() -> dict:
    path = os.environ.get("RAN_AGENT_STEWARD_IDENTITY_FILE", "").strip()
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception as exc:
        raise StewardError("STEWARD_UNAVAILABLE", "identity unavailable", 503, True) from exc
    keys = {
        "base_upstream_commit",
        "patch_manifest_sha256",
        "api_schema_sha256",
        "effective_source_tree_sha256",
    }
    _strict(value, keys, "identity")
    if not re.fullmatch(r"[a-f0-9]{40}", value["base_upstream_commit"]):
        raise StewardError("STEWARD_UNAVAILABLE", "identity invalid", 503, True)
    for key in keys - {"base_upstream_commit"}:
        if not SHA256.fullmatch(value[key]):
            raise StewardError("STEWARD_UNAVAILABLE", "identity invalid", 503, True)
    return value


def _token() -> str:
    path = os.environ.get("RAN_AGENT_STEWARD_TOKEN_FILE", "").strip()
    try:
        info = os.lstat(path)
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
            raise OSError("not a regular file")
        if info.st_uid != os.geteuid() or info.st_gid != os.getegid():
            raise OSError("owner mismatch")
        if stat.S_IMODE(info.st_mode) != 0o600:
            raise OSError("mode mismatch")
        value = Path(path).read_text(encoding="ascii")
    except Exception as exc:
        raise StewardError("STEWARD_UNAVAILABLE", "auth store unavailable", 503, True) from exc
    if not re.fullmatch(r"[a-f0-9]{64}\n", value):
        raise StewardError("STEWARD_UNAVAILABLE", "auth store unavailable", 503, True)
    return value[:-1]


def _authenticate(request: Request) -> None:
    supplied = request.headers.get(TOKEN_HEADER, "")
    if not re.fullmatch(r"[a-f0-9]{64}", supplied) or not hmac.compare_digest(supplied, _token()):
        raise StewardError("STEWARD_AUTH_INVALID", "invalid authentication", 401)


def _validate_source(source) -> None:
    keys = {
        "compat_protocol_id",
        "source_event_id",
        "source_revision",
        "source_event_digest",
        "candidate_payload_digest",
        "scope_envelope_digest",
        "sensitivity",
        "deletion_domain",
        "adapter_policy_digest",
    }
    _strict(source, keys, "source")
    if source["compat_protocol_id"] != PROTOCOL_ID:
        raise StewardError("STEWARD_SCHEMA_INVALID", "source protocol invalid")
    if not SOURCE_ID.fullmatch(source["source_event_id"]):
        raise StewardError("STEWARD_SCHEMA_INVALID", "source id invalid")
    if not isinstance(source["source_revision"], int) or source["source_revision"] < 0:
        raise StewardError("STEWARD_SCHEMA_INVALID", "source revision invalid")
    for key in ("source_event_digest", "candidate_payload_digest", "scope_envelope_digest", "adapter_policy_digest"):
        if not isinstance(source[key], str) or not SHA256.fullmatch(source[key]):
            raise StewardError("STEWARD_SCHEMA_INVALID", f"{key} invalid")
    if source["sensitivity"] not in {"public", "standard", "personal", "sensitive", "sealed"}:
        raise StewardError("STEWARD_SCHEMA_INVALID", "sensitivity invalid")
    if source["deletion_domain"] != "compat_payload_default":
        raise StewardError("STEWARD_SCHEMA_INVALID", "deletion_domain invalid")


def _validate_params(method: str, params) -> None:
    required = {
        "append_experience": {"body"},
        "append_association": {"body", "endpoint_refs"},
        "append_low_impact_preference_observation": {"body", "non_current"},
        "append_i_observation_candidate": {"body", "candidate_only"},
        "append_correction_or_supersession_observation": {"body", "supersedes_target_ref"},
        "suppress": {"target_ref", "lifecycle_ref", "expected_revision"},
        "tombstone": {"target_ref", "lifecycle_ref", "expected_revision"},
        "total_delete": {
            "target_ref",
            "lifecycle_ref",
            "expected_revision",
            "cascade_manifest_digest",
            "source_deletion_receipt",
        },
        "reconcile_operation": {"operation_key"},
        "get_operation_receipt": {"operation_key", "attempt_number"},
        "get_target_revision": {"target_ref"},
    }[method]
    _strict(params, required, "params")
    if method in APPENDS:
        body = params["body"]
        if not isinstance(body, str) or not 1 <= len(body.encode()) <= 8192:
            raise StewardError("STEWARD_SCHEMA_INVALID", "body invalid")
    if method == "append_association":
        refs = params["endpoint_refs"]
        if not isinstance(refs, list) or len(refs) != 2 or not all(isinstance(v, str) and TARGET_REF.fullmatch(v) for v in refs):
            raise StewardError("STEWARD_SCHEMA_INVALID", "endpoint_refs invalid")
    if method == "append_low_impact_preference_observation" and params["non_current"] is not True:
        raise StewardError("STEWARD_SCHEMA_INVALID", "non_current invalid")
    if method == "append_i_observation_candidate" and params["candidate_only"] is not True:
        raise StewardError("STEWARD_SCHEMA_INVALID", "candidate_only invalid")
    if method == "append_correction_or_supersession_observation" and not TARGET_REF.fullmatch(params["supersedes_target_ref"]):
        raise StewardError("STEWARD_SCHEMA_INVALID", "supersedes_target_ref invalid")
    if method in {"suppress", "tombstone", "total_delete"}:
        if not isinstance(params["target_ref"], str) or not TARGET_REF.fullmatch(params["target_ref"]):
            raise StewardError("STEWARD_SCHEMA_INVALID", "target_ref invalid")
        if not isinstance(params["lifecycle_ref"], str) or not LIFECYCLE_REF.fullmatch(params["lifecycle_ref"]):
            raise StewardError("STEWARD_SCHEMA_INVALID", "lifecycle_ref invalid")
        if not isinstance(params["expected_revision"], int) or params["expected_revision"] < 1:
            raise StewardError("STEWARD_SCHEMA_INVALID", "expected_revision invalid")
    if method == "total_delete":
        if not isinstance(params["cascade_manifest_digest"], str) or not SHA256.fullmatch(params["cascade_manifest_digest"]):
            raise StewardError("STEWARD_SCHEMA_INVALID", "cascade digest invalid")
    if method in {"reconcile_operation", "get_operation_receipt"}:
        if not isinstance(params["operation_key"], str) or not SHA256.fullmatch(params["operation_key"]):
            raise StewardError("STEWARD_SCHEMA_INVALID", "operation_key invalid")
    if method == "get_operation_receipt" and params["attempt_number"] is not None:
        if not isinstance(params["attempt_number"], int) or params["attempt_number"] < 1:
            raise StewardError("STEWARD_SCHEMA_INVALID", "attempt_number invalid")
    if method == "get_target_revision" and (not isinstance(params["target_ref"], str) or not TARGET_REF.fullmatch(params["target_ref"])):
        raise StewardError("STEWARD_SCHEMA_INVALID", "target_ref invalid")


def _validate_envelope(value, allowed: set[str]) -> None:
    _strict(value, {"schema_version", "method", "operation_key", "idempotency_key", "attempt", "source", "params", "meta"}, "request")
    if value["schema_version"] != API_VERSION or value["method"] not in allowed:
        raise StewardError("STEWARD_SCHEMA_INVALID", "method or version invalid")
    if not isinstance(value["operation_key"], str) or not SHA256.fullmatch(value["operation_key"]):
        raise StewardError("STEWARD_SCHEMA_INVALID", "operation_key invalid")
    _strict(value["attempt"], {"attempt_id", "attempt_number"}, "attempt")
    if not ATTEMPT_ID.fullmatch(value["attempt"]["attempt_id"]) or not isinstance(value["attempt"]["attempt_number"], int) or value["attempt"]["attempt_number"] < 1:
        raise StewardError("STEWARD_SCHEMA_INVALID", "attempt invalid")
    if value["idempotency_key"] != f'{value["operation_key"]}:{value["attempt"]["attempt_number"]}':
        raise StewardError("STEWARD_SCHEMA_INVALID", "idempotency key invalid")
    _strict(value["meta"], {"adapter_id", "adapter_version", "issued_at"}, "meta")
    if not all(isinstance(value["meta"][key], str) and 1 <= len(value["meta"][key]) <= 80 for key in ("adapter_id", "adapter_version")):
        raise StewardError("STEWARD_SCHEMA_INVALID", "meta invalid")
    _validate_source(value["source"])
    _validate_params(value["method"], value["params"])


def _store_path() -> Path:
    buckets = Path(sh.config.get("buckets_dir") or "buckets")
    return buckets / ".ran-agent-steward-v1.json"


def _load_store() -> dict:
    path = _store_path()
    if not path.exists():
        return {"operations": {}, "targets": {}}
    value = json.loads(path.read_text(encoding="utf-8"))
    _strict(value, {"operations", "targets"}, "store")
    if not isinstance(value["operations"], dict) or not isinstance(value["targets"], dict):
        raise StewardError("STEWARD_UNAVAILABLE", "store invalid", 503, True)
    return value


def _save_store(value: dict) -> None:
    path = _store_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        handle.write(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def _receipt(request, *, target, evidence_ref, idempotency="new", outcome="succeeded", error=None) -> dict:
    return {
        "schema_version": RECEIPT_VERSION,
        "ok": outcome == "succeeded",
        "outcome": outcome,
        "error": error,
        "idempotency": idempotency,
        "operation_key": request["operation_key"],
        "idempotency_key": request["idempotency_key"],
        "attempt": request["attempt"],
        "source": request["source"],
        "target": target,
        "evidence_ref": evidence_ref,
        "api_version": API_VERSION,
        **_identity(),
        "issued_at": _now(),
        "issuer_id": "ombre-brain-steward/1",
    }


async def _mutate(value) -> dict:
    method, params = value["method"], value["params"]
    if method == "total_delete":
        raise StewardError("STEWARD_SOURCE_TOTAL_DELETE_UNSUPPORTED", "source total delete unsupported", 501)
    request_digest = _digest(value)
    async with _LOCK:
        store = _load_store()
        prior = store["operations"].get(value["idempotency_key"])
        if prior:
            if prior["request_digest"] != request_digest:
                raise StewardError("STEWARD_IDEMPOTENCY_CONFLICT", "idempotency conflict", 409)
            return {**prior["receipt"], "idempotency": "exact_replay"}
        target = None
        if method in APPENDS:
            bucket_id = await sh.bucket_mgr.create(
                content=params["body"],
                tags=["ran-agent-steward", APPENDS[method]],
                source_tool="ran-agent-steward",
                bucket_type="dynamic",
            )
            target_ref = f"ombre-steward://target/{APPENDS[method]}/{bucket_id}"
            target = {"target_ref": target_ref, "revision_before": 0, "revision_after": 1}
            store["targets"][target_ref] = {"bucket_id": bucket_id, "revision": 1, "lifecycle_state": "current"}
        else:
            record = store["targets"].get(params["target_ref"])
            if not record:
                raise StewardError("STEWARD_TARGET_NOT_FOUND", "target not found", 404)
            if record["revision"] != params["expected_revision"]:
                raise StewardError("STEWARD_REVISION_CONFLICT", "revision conflict", 409)
            before = record["revision"]
            if method == "suppress":
                ok = await sh.bucket_mgr.update(record["bucket_id"], dont_surface=True)
                state = "suppressed"
            else:
                ok = await sh.bucket_mgr.delete(record["bucket_id"])
                state = "tombstoned"
            if not ok:
                raise StewardError("STEWARD_TARGET_NOT_FOUND", "target not found", 404)
            record.update(revision=before + 1, lifecycle_state=state)
            target = {"target_ref": params["target_ref"], "revision_before": before, "revision_after": before + 1}
        receipt = _receipt(value, target=target, evidence_ref=f"ombre-steward://receipt/{value['idempotency_key']}")
        store["operations"][value["idempotency_key"]] = {
            "request_digest": request_digest,
            "receipt": receipt,
            "source": value["source"],
        }
        _save_store(store)
        return receipt


def _read(value) -> dict:
    store = _load_store()
    method, params = value["method"], value["params"]
    if method == "get_target_revision":
        target = store["targets"].get(params["target_ref"])
        if not target:
            raise StewardError("STEWARD_TARGET_NOT_FOUND", "target not found", 404)
        return _receipt(
            value,
            target={
                "target_ref": params["target_ref"],
                "revision_before": target["revision"],
                "revision_after": target["revision"],
            },
            evidence_ref=None,
        )
    candidates = [
        row for row in store["operations"].values()
        if row["receipt"]["operation_key"] == params["operation_key"]
    ]
    if not candidates:
        raise StewardError("STEWARD_TARGET_NOT_FOUND", "operation not found", 404)
    if any(row["source"] != value["source"] for row in candidates):
        raise StewardError("STEWARD_SOURCE_BINDING_CONFLICT", "source binding conflict", 409)
    if method == "get_operation_receipt":
        attempt = params["attempt_number"]
        if attempt is not None:
            candidates = [row for row in candidates if row["receipt"]["attempt"]["attempt_number"] == attempt]
            if not candidates:
                raise StewardError("STEWARD_TARGET_NOT_FOUND", "receipt not found", 404)
        row = max(candidates, key=lambda candidate: candidate["receipt"]["attempt"]["attempt_number"])
        return {**row["receipt"], "idempotency": "exact_replay"}
    row = max(candidates, key=lambda candidate: candidate["receipt"]["attempt"]["attempt_number"])
    receipt = row["receipt"]
    return _receipt(value, target=receipt["target"], evidence_ref=receipt["evidence_ref"])


def _error(exc: StewardError) -> JSONResponse:
    return JSONResponse(
        {"ok": False, "error": {"code": exc.code, "message": str(exc)[:200], "retryable": exc.retryable}},
        status_code=exc.status,
        headers={"Cache-Control": "no-store"},
    )


def register(mcp) -> None:
    @mcp.custom_route("/internal/ran-agent/steward/v1/health", methods=["GET"])
    async def health(request: Request):
        try:
            _authenticate(request)
            return JSONResponse({"status": "ok", "schema_version": API_VERSION, **_identity()}, headers={"Cache-Control": "no-store"})
        except StewardError as exc:
            return _error(exc)

    @mcp.custom_route("/internal/ran-agent/steward/v1/mutate", methods=["POST"])
    async def mutate(request: Request):
        try:
            _authenticate(request)
            value = await request.json()
            _validate_envelope(value, MUTATIONS)
            return JSONResponse(await _mutate(value), headers={"Cache-Control": "no-store"})
        except (json.JSONDecodeError, UnicodeDecodeError):
            return _error(StewardError("STEWARD_SCHEMA_INVALID", "invalid JSON"))
        except StewardError as exc:
            return _error(exc)

    @mcp.custom_route("/internal/ran-agent/steward/v1/reconcile", methods=["POST"])
    async def reconcile(request: Request):
        try:
            _authenticate(request)
            value = await request.json()
            _validate_envelope(value, READS)
            return JSONResponse(_read(value), headers={"Cache-Control": "no-store"})
        except (json.JSONDecodeError, UnicodeDecodeError):
            return _error(StewardError("STEWARD_SCHEMA_INVALID", "invalid JSON"))
        except StewardError as exc:
            return _error(exc)
