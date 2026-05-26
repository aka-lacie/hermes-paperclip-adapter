import json
import os
import sys
import threading

PREFIX = "__PAPERCLIP_TRANSCRIPT__ "
_lock = threading.Lock()
_counter = 0
_pending = {}


def _enabled():
    return os.environ.get("PAPERCLIP_HERMES_STRUCTURED_EVENTS", "").lower() in {"1", "true", "yes", "on"}


def _next_id():
    global _counter
    with _lock:
        _counter += 1
        return f"paperclip-tool-{_counter}"


def _jsonable(value):
    try:
        json.dumps(value, ensure_ascii=False)
        return value
    except Exception:
        return str(value)


def _key(name, args):
    try:
        return json.dumps([name or "tool", args or {}], ensure_ascii=False, sort_keys=True, default=str)
    except Exception:
        return json.dumps([name or "tool", str(args or {})], ensure_ascii=False)


def _redact(text):
    try:
        from agent.redact import redact_sensitive_text

        return redact_sensitive_text(text, force=True)
    except Exception:
        return text


def _result_text(result):
    try:
        from agent.tool_dispatch_helpers import _multimodal_text_summary

        text = _multimodal_text_summary(result)
    except Exception:
        text = str(result)
    text = _redact(text)
    try:
        max_chars = int(os.environ.get("PAPERCLIP_HERMES_TOOL_RESULT_MAX_CHARS", "24000") or "24000")
    except Exception:
        max_chars = 24000
    if max_chars > 0 and len(text) > max_chars:
        omitted = len(text) - max_chars
        text = text[:max_chars].rstrip() + f"\n... truncated {omitted} chars ..."
    return text


def _is_error(result):
    text = str(result)[:500].lower()
    return '"error"' in text or '"failed"' in text or text.startswith("error")


def _emit(payload):
    if not _enabled():
        return
    try:
        sys.stdout.write(PREFIX + json.dumps(payload, ensure_ascii=False, default=str) + "\n")
        sys.stdout.flush()
    except Exception:
        pass


def _remember(name, args, tool_id):
    key = _key(name, args)
    with _lock:
        _pending.setdefault(key, []).append(tool_id)


def _take(name, args):
    key = _key(name, args)
    with _lock:
        values = _pending.get(key) or []
        if values:
            tool_id = values.pop(0)
            if not values:
                _pending.pop(key, None)
            return tool_id
    return None


def _pre_tool_call(tool_name=None, args=None, tool_call_id="", **kwargs):
    if not _enabled():
        return None
    name = str(tool_name or "tool")
    clean_args = _jsonable(args if isinstance(args, dict) else {})
    tool_id = str(tool_call_id or "") or _next_id()
    _remember(name, clean_args, tool_id)
    _emit({
        "kind": "tool_call",
        "toolUseId": tool_id,
        "name": name,
        "input": clean_args,
    })
    return None


def _post_tool_call(tool_name=None, args=None, result="", tool_call_id="", duration_ms=None, **kwargs):
    if not _enabled():
        return None
    name = str(tool_name or "tool")
    clean_args = _jsonable(args if isinstance(args, dict) else {})
    tool_id = _take(name, clean_args) or str(tool_call_id or "") or _next_id()
    payload = {
        "kind": "tool_result",
        "toolUseId": tool_id,
        "toolName": name,
        "content": _result_text(result),
        "isError": bool(_is_error(result)),
    }
    if duration_ms is not None:
        payload["durationMs"] = duration_ms
    _emit(payload)
    return None


def register(ctx):
    ctx.register_hook("pre_tool_call", _pre_tool_call)
    ctx.register_hook("post_tool_call", _post_tool_call)
