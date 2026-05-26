/**
 * Parse Hermes Agent stdout into TranscriptEntry objects for the Paperclip UI.
 *
 * Hermes CLI quiet-mode output patterns:
 *   Inner thought: "  ┊ 💬 {text}"              → thinking (stream-of-consciousness)
 *   Tool (TTY):    "  ┊ {emoji} {verb:9} {detail}  {duration}"
 *   Tool (pipe):   "  [done] ┊ {emoji} {verb:9} {detail}  {duration} ({total})"
 *   System:        "[hermes] ..."
 *   Assistant:     bare lines after activity    → the final "out loud" response
 *
 * We emit structured tool_call/tool_result pairs so Paperclip renders proper
 * tool cards (with status icons, expand/collapse) instead of raw stdout blocks.
 *
 * Output structure:
 *   All ┊ lines are internal activity (tool calls, inner thoughts).
 *   Bare lines (no ┊ prefix) that appear after tool activity or a blank line
 *   are the actual assistant response — these must NOT be suppressed.
 *
 * Multi-line commands: Hermes splits multi-line tool output across separate
 * stdout chunks (separated by \r\n). The first line has the ┊ prefix, but
 * continuation lines (the actual command body) do not. We suppress these
 * ONLY immediately after a tool_result, until a blank line resets the state.
 */

import type { TranscriptEntry } from "@paperclipai/adapter-utils";

import { TOOL_OUTPUT_PREFIX } from "../shared/constants.js";

const PAPERCLIP_TRANSCRIPT_EVENT_PREFIX = "__PAPERCLIP_TRANSCRIPT__ ";

// ── Kaomoji / noise stripping ──────────────────────────────────────────────

/**
 * Strip kawaii faces and decorative emoji from a tool summary line.
 * Leaves meaningful emoji (💻 for terminal, 🔍 for search, etc.) intact
 * by only stripping parenthesized kaomoji like (｡◕‿◕｡).
 */
function stripKaomoji(text: string): string {
  // Strip parenthesized kaomoji faces: (｡◕‿◕｡), (★ω★), etc.
  return text.replace(/[(][^()]{2,20}[)]\s*/gu, "").trim();
}

// ── Line classification ────────────────────────────────────────────────────

/** Check if a ┊ line is an assistant message (┊ 💬 ...). */
function isAssistantToolLine(stripped: string): boolean {
  return /^┊\s*💬/.test(stripped);
}

/** Extract assistant text from a ┊ 💬 line. */
function extractAssistantText(line: string): string {
  return line.replace(/^[\s┊]*💬\s*/, "").trim();
}

/**
 * Parse a tool completion line into structured data.
 *
 * Handles both TTY and pipe formats:
 *   TTY:  ┊ 💻 $         curl -s "..."  0.1s
 *   Pipe: [done] ┊ 💻 $   curl -s "..."  0.1s (0.5s)
 */
function parseToolCompletionLine(
  line: string,
): { name: string; detail: string; duration: string; hasError: boolean } | null {
  // Strip leading whitespace and [done] prefix
  let cleaned = line.trim().replace(/^\[done\]\s*/, "");

  // Must start with ┊
  if (!cleaned.startsWith(TOOL_OUTPUT_PREFIX)) return null;

  // Remove ┊ prefix and any leading kaomoji face
  cleaned = cleaned.slice(TOOL_OUTPUT_PREFIX.length);
  cleaned = stripKaomoji(cleaned).trim();
  cleaned = cleaned.replace(/^(?:\p{Emoji_Presentation}|\p{Extended_Pictographic})\s+/u, "").trim();

  // Now format is: "{verb:9} {detail}  {duration}" or "{verb:9} {detail}  {duration} ({total})"
  // Example: "$         curl -s ..." or "search    pattern  0.1s"
  // The verb+detail are separated by whitespace, duration is at the end

  // Match: emoji + verb + detail + duration
  // Duration pattern: N.Ns (possibly followed by (N.Ns))
  const durationMatch = cleaned.match(/([\d.]+s)\s*(?:\([\d.]+s\))?\s*$/);
  const duration = durationMatch ? durationMatch[1] : "";

  // Remove duration from the end to get verb + detail
  let verbAndDetail = durationMatch
    ? cleaned.slice(0, cleaned.lastIndexOf(durationMatch[0])).trim()
    : cleaned;

  // Check for error suffixes
  const hasError = /\[(?:exit \d+|error|full)\]/.test(verbAndDetail) ||
    /\[error\]\s*$/.test(cleaned);

  // The first token (after emoji) is the verb, rest is detail
  // Verbs are always a single word or symbol ($ for terminal)
  const parts = verbAndDetail.match(/^(\S+)\s+(.*)/);
  if (!parts) {
    return { name: "tool", detail: verbAndDetail, duration, hasError };
  }

  const verb = parts[1];
  const detail = parts[2].trim();

  // Map Hermes verbs to readable tool names
  const nameMap: Record<string, string> = {
    "$": "terminal",
    "exec": "terminal",
    "terminal": "terminal",
    "search": "web_search",
    "fetch": "web_extract",
    "crawl": "web_crawl",
    "navigate": "browser_navigate",
    "snapshot": "browser_snapshot",
    "click": "browser_click",
    "type": "browser_type",
    "scroll": "browser_scroll",
    "back": "browser_back",
    "press": "browser_press",
    "close": "browser_close",
    "images": "browser_get_images",
    "vision": "browser_vision",
    "read": "read_file",
    "write": "write_file",
    "patch": "patch",
    "grep": "search_files",
    "find": "search_files",
    "plan": "todo",
    "recall": "session_search",
    "proc": "process",
    "delegate": "delegate",
    "todo": "todo",
    "memory": "memory",
    "clarify": "clarify",
    "session_search": "session_search",
    "code": "execute",
    "execute": "execute",
    "web_search": "web_search",
    "web_extract": "web_extract",
    "browser_navigate": "browser_navigate",
    "browser_click": "browser_click",
    "browser_type": "browser_type",
    "browser_snapshot": "browser_snapshot",
    "browser_vision": "browser_vision",
    "browser_scroll": "browser_scroll",
    "browser_press": "browser_press",
    "browser_back": "browser_back",
    "browser_close": "browser_close",
    "browser_get_images": "browser_get_images",
    "read_file": "read_file",
    "write_file": "write_file",
    "search_files": "search_files",
    "patch_file": "patch",
    "execute_code": "execute",
  };

  const name = nameMap[verb.toLowerCase()] || verb;

  return { name, detail, duration, hasError };
}

// ── Synthetic tool ID generation ────────────────────────────────────────────

let toolCallCounter = 0;

/**
 * Generate a synthetic toolUseId for pairing tool_call with tool_result.
 * Paperclip uses this to match them in normalizeTranscript.
 */
function syntheticToolUseId(): string {
  return `hermes-tool-${++toolCallCounter}`;
}

function compactToolDetail(detail: string, maxLength = 96): string {
  const oneLine = detail.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxLength) return oneLine;
  return `${oneLine.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function displayToolName(toolInfo: { name: string; detail: string }): string {
  const detail = compactToolDetail(toolInfo.detail);
  return detail ? `${toolInfo.name}: ${detail}` : toolInfo.name;
}

// ── Multi-line command continuation tracking ───────────────────────────────

/**
 * Track multi-line command continuation state.
 *
 * After a tool_result is emitted, the NEXT line(s) may be continuation
 * noise from the command body (split across \r\n chunks). These are
 * immediately after the tool line with no blank separator.
 *
 * A blank line resets this state — it signals the end of tool activity
 * and the start of the actual assistant response (bare lines).
 */
let suppressContinuation = false;
let structuredResultsPendingCute = 0;
const pendingStructuredToolUseIds: string[] = [];

// ── Pre-tool-invocation suppression ────────────────────────────────────────
// After an assistant/thinking entry, bare lines that look like shell command
// arguments (curl flags, continuation backslashes) are tool invocation noise,
// not prose. Hermes outputs tool call arguments as bare lines in quiet mode.
// Suppress them until a ┊ tool completion line or blank line resets the state.
let lastWasProse = false;
let inPreToolBlock = false;

function isToolInvocationLine(line: string): boolean {
  // Shell commands with flags (not bare command names like prose mentions)
  // e.g. "curl -s -X POST ..." or "git push origin ..." but not "curl is a tool"
  // Network commands (require flags to distinguish from prose mentions)
  if (/^(?:curl|wget|ssh|scp|rsync)\b/.test(line) && / -[A-Za-z]/.test(line)) return true;
  // Dev-tool commands (bare word + any args = invocation, not prose)
  if (/^(?:git|npm|bun|yarn|pnpm|docker|kubectl|aws|gh)\b/.test(line) && /\s/.test(line)) return true;
  // Runtime / package managers
  if (/^(?:python3?|node|npx|pip3?)\s/.test(line)) return true;
  // File / shell commands commonly used as tool arguments
  if (/^(?:cat|less|more|head|tail|grep|egrep|fgrep|sed|awk|find|ls|cd|mkdir|rmdir|rm|mv|cp|chmod|chown|touch|ln|stat|file|wc|sort|uniq|diff|tee|xargs|cut|tr|echo|source|export|env|which|pwd|tar|zip|unzip)\b/.test(line) && /\s/.test(line)) return true;
  // Flag-only lines: -H, -d, -X, -s, etc. (shell continuation)
  if (/^-[^-\s]/.test(line)) return true;
  // Lines ending with backslash (shell line continuation)
  if (line.endsWith("\\")) return true;
  // Lines starting with backslash (continuation marker)
  if (/^\\/.test(line)) return true;
  return false;
}

// ── Thinking detection ─────────────────────────────────────────────────────

function isThinkingLine(line: string): boolean {
  return (
    line.includes("💭") ||
    line.startsWith("<thinking>") ||
    line.startsWith("</thinking>") ||
    line.startsWith("Thinking:")
  );
}

function parsePaperclipTranscriptEvent(line: string, ts: string): TranscriptEntry[] | null {
  if (!line.startsWith(PAPERCLIP_TRANSCRIPT_EVENT_PREFIX)) return null;
  const raw = line.slice(PAPERCLIP_TRANSCRIPT_EVENT_PREFIX.length).trim();
  if (!raw) return [];

  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    payload = parsed as Record<string, unknown>;
  } catch {
    return [];
  }

  if (payload.kind === "tool_call") {
    const name = typeof payload.name === "string" && payload.name.trim()
      ? payload.name.trim()
      : "tool";
    const toolUseId = typeof payload.toolUseId === "string" && payload.toolUseId.trim()
      ? payload.toolUseId.trim()
      : syntheticToolUseId();
    return [{
      kind: "tool_call" as const,
      ts,
      name,
      input: (payload.input && typeof payload.input === "object" && !Array.isArray(payload.input))
        ? payload.input as Record<string, unknown>
        : {},
      toolUseId,
    }] as TranscriptEntry[];
  }

  if (payload.kind === "tool_result") {
    const toolUseId = typeof payload.toolUseId === "string" && payload.toolUseId.trim()
      ? payload.toolUseId.trim()
      : syntheticToolUseId();
    const toolName = typeof payload.toolName === "string" && payload.toolName.trim()
      ? payload.toolName.trim()
      : typeof payload.name === "string" && payload.name.trim()
        ? payload.name.trim()
        : "tool";
    return [{
      kind: "tool_result" as const,
      ts,
      toolUseId,
      toolName,
      content: typeof payload.content === "string" ? payload.content : String(payload.content ?? ""),
      isError: payload.isError === true,
    }] as TranscriptEntry[];
  }

  return [];
}

// ── Main parser ────────────────────────────────────────────────────────────

/**
 * Parse a single line of Hermes stdout into transcript entries.
 *
 * Emits structured tool_call/tool_result pairs (with synthetic IDs) so
 * Paperclip renders proper tool cards with status icons and expand/collapse.
 *
 * @param line  Raw stdout line from Hermes CLI
 * @param ts    ISO timestamp for the entry
 * @returns     Array of TranscriptEntry objects (may be empty)
 */
export function parseHermesStdoutLine(
  line: string,
  ts: string,
): TranscriptEntry[] {
  const trimmed = line.trim();

  // ── Blank line → resets continuation suppression ─────────────────────
  // Blank lines signal the boundary between tool activity and the
  // assistant's actual response. After a blank line, bare lines
  // are real output, not command continuation noise.
  if (!trimmed) {
    suppressContinuation = false;
    return [];
  }

  const structuredEntries = parsePaperclipTranscriptEvent(trimmed, ts);
  if (structuredEntries) {
    suppressContinuation = false;
    lastWasProse = false;
    for (const entry of structuredEntries) {
      if (entry.kind === "tool_call" && entry.toolUseId) {
        pendingStructuredToolUseIds.push(entry.toolUseId);
      } else if (entry.kind === "tool_result") {
        structuredResultsPendingCute += 1;
        if (entry.toolUseId) {
          const index = pendingStructuredToolUseIds.indexOf(entry.toolUseId);
          if (index >= 0) pendingStructuredToolUseIds.splice(index, 1);
        }
      }
    }
    return structuredEntries;
  }

  // ── Hermes box-drawing banner (╭─ ⚕ Hermes ── / ╰──) ─────────────
  if (/^╭[─┄┈┅┆│ ⚕]/.test(trimmed) || /^╰[─┄┈┅┆│]/.test(trimmed)) {
    return [];
  }

  // ── System/adapter messages ────────────────────────────────────────────
  if (trimmed.startsWith("[hermes]") || trimmed.startsWith("[paperclip]")) {
    suppressContinuation = false;
    lastWasProse = false;
    return [{ kind: "system", ts, text: trimmed }];
  }

  // ── Non-quiet mode tool start lines: [tool] (kaomoji) emoji verb ... ──
  // These are redundant — the tool_call/tool_result pair arrives later from
  // the ┊ completion line. Skip them to avoid duplicate entries.
  if (trimmed.startsWith("[tool]")) {
    lastWasProse = false;
    return [];
  }

  // ── Hermes 0.7.0 "preparing" lines ──────────────────────────────
  // e.g. "📖 preparing read_file…" — tool announcement, not prose
  if (/^.\s+preparing\s+/.test(trimmed)) {
    lastWasProse = false;
    return [];
  }

  // ── MCP / server init noise reclassified from stderr by wrappedOnLog ──
  // Pattern: [2026-03-25T10:40:53.941Z] INFO: ...
  // Emit as stderr so Paperclip groups them into the amber accordion.
  if (/^\[\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
    suppressContinuation = false;
    lastWasProse = false;
    return [{ kind: "stderr", ts, text: trimmed }];
  }

  // ── Standalone spinner remnants: "💻 Completed", "💻\nCompleted", etc. ─
  // These are non-quiet mode spinner frame leftovers — skip them.
  if (/^\p{Emoji_Presentation}\s*(Completed|Running|Error)?\s*$/u.test(trimmed)) {
    return [];
  }

  // ── Session info line ────────────────────────────────────────────────
  if (trimmed.startsWith("session_id:")) {
    suppressContinuation = false;
    lastWasProse = false;
    return [{ kind: "system", ts, text: trimmed }];
  }

  // ── Quiet-mode tool/message lines (prefixed with ┊) ────────────────────
  if (trimmed.includes(TOOL_OUTPUT_PREFIX)) {
    // Inner thought: ┊ 💬 {text} → thinking, not assistant output
    // These are the model's stream-of-consciousness while working.
    // The actual "out loud" response arrives as bare lines later.
    if (isAssistantToolLine(trimmed)) {
      suppressContinuation = false;
      lastWasProse = true;
      return [{ kind: "thinking", ts, text: extractAssistantText(trimmed) }];
    }

    // Tool completion: ┊ {emoji} {verb} {detail} {duration}
    const toolInfo = parseToolCompletionLine(trimmed);
    if (toolInfo) {
      const name = displayToolName(toolInfo);
      const detailText = toolInfo.duration
        ? `${toolInfo.detail}  ${toolInfo.duration}`
        : toolInfo.detail;

      // Track this tool result for potential continuation lines
      suppressContinuation = true;
      lastWasProse = false;
      if (structuredResultsPendingCute > 0) {
        structuredResultsPendingCute -= 1;
        return [];
      }
      const pendingId = pendingStructuredToolUseIds.shift();
      if (pendingId) {
        return [
          {
            kind: "tool_result" as const,
            ts,
            toolUseId: pendingId,
            toolName: name,
            content: detailText,
            isError: toolInfo.hasError,
          },
        ] as TranscriptEntry[];
      }
      const id = syntheticToolUseId();

      return [
        {
          kind: "tool_call" as const,
          ts,
          name,
          input: { name: toolInfo.name, detail: toolInfo.detail },
          toolUseId: id,
        },
        {
          kind: "tool_result" as const,
          ts,
          toolUseId: id,
          toolName: name,
          content: detailText,
          isError: toolInfo.hasError,
        },
      ] as TranscriptEntry[];
    }

    // Fallback: raw ┊ line that doesn't match tool format
    const stripped = trimmed
      .replace(/^\[done\]\s*/, "")
      .replace(new RegExp(`^${TOOL_OUTPUT_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`), "")
      .trim();
    suppressContinuation = false;
    lastWasProse = false;
    return [{ kind: "stdout", ts, text: stripped }];
  }

  // ── Multi-line command continuation (noise) ─────────────────────────────
  // After a tool_result, bare lines are continuation noise from multi-line
  // command bodies split across \r\n chunks. Keep suppressing until a
  // blank line resets the state.
  //
  // We detect end-of-continuation by:
  //   1. Blank line → definite boundary
  //   2. Bare duration "1.0s" or closing-quote+duration → end of tool cmd
  //   3. Lines that look like prose (start with capital letter, no leading
  //      indentation, no code syntax) → likely real assistant output
  if (suppressContinuation) {
    // Blank line → end of tool block
    if (!trimmed) {
      suppressContinuation = false;
      return [];
    }
    // Duration-only line (trailing timing from tool command)
    if (/^\s*\d+\.\d+s\s*$/.test(trimmed)) {
      suppressContinuation = false;
      return [];
    }
    // Closing quote + duration: '"  1.0s or "' 1.0s
    if (/^["']\s*\d+\.\d+s\s*$/.test(trimmed)) {
      suppressContinuation = false;
      return [];
    }
    // Lines starting with ┊ are new tool/message activity, not continuation
    if (trimmed.startsWith(TOOL_OUTPUT_PREFIX)) {
      suppressContinuation = false;
      // Don't return here — let the ┊ handler above process it on next call
      // Actually we can't re-enter, so fall through after resetting
      return [{ kind: "assistant", ts, text: trimmed }];
    }
    // Duration at end of a continuation line: '-d '{"status":"done"}'  1.0s'
    if (/\d+\.\d+s\s*$/.test(trimmed) && /^(["']?\s*[-\\])/.test(trimmed)) {
      suppressContinuation = false;
      return [];
    }
    // Shell/curl continuation flags — NEVER prose
    if (/^[-\\]/.test(trimmed)) {
      return [];
    }
    // Heuristic: if the line looks like prose (not code), stop suppressing.
    // Code continuation lines typically have: leading whitespace, Python/JS syntax,
    // JSON, operators, closing brackets. Prose starts with a capital letter
    // or common sentence starters and has no code-like patterns.
    const looksLikeProse = /^[A-Z"*#\d(]/.test(trimmed) &&
      !/[{}()\[\];:=]/.test(trimmed.slice(0, 20)) &&
      !trimmed.startsWith("import ") &&
      !trimmed.startsWith("from ") &&
      !trimmed.startsWith("const ") &&
      !trimmed.startsWith("let ") &&
      !trimmed.startsWith("var ") &&
      !trimmed.startsWith("if ") &&
      !trimmed.startsWith("for ") &&
      !trimmed.startsWith("while ") &&
      !trimmed.startsWith("def ") &&
      !trimmed.startsWith("class ") &&
      !trimmed.startsWith("return ") &&
      !trimmed.startsWith("print(");
    if (looksLikeProse) {
      suppressContinuation = false;
      lastWasProse = true;
      return [{ kind: "assistant", ts, text: trimmed }];
    }
    // Still looks like continuation code — suppress and keep tracking
    return [];
  }

  // ── Thinking blocks ────────────────────────────────────────────────────
  if (isThinkingLine(trimmed)) {
    return [
      {
        kind: "thinking",
        ts,
        text: trimmed.replace(/^💭\s*/, ""),
      },
    ];
  }

  // ── Error output ───────────────────────────────────────────────────────
  if (
    trimmed.startsWith("Error:") ||
    trimmed.startsWith("ERROR:") ||
    trimmed.startsWith("Traceback")
  ) {
    return [{ kind: "stderr", ts, text: trimmed }];
  }

  // ── Pre-tool-invocation suppression ─────────────────────────────────────
  // After prose (assistant/thinking), bare lines that look like shell commands
  // are tool invocation arguments, not assistant text. Suppress until a ┊
  // completion line or blank line resets the state.
  if (inPreToolBlock) {
    if (!trimmed) {
      inPreToolBlock = false;
      return [];
    }
    if (trimmed.startsWith(TOOL_OUTPUT_PREFIX)) {
      inPreToolBlock = false;
      lastWasProse = false;
      // Fall through to ┊ handling below (can't re-enter, emit as stdout)
      const stripped = trimmed
        .replace(/^\[done\]\s*/, "")
        .replace(new RegExp(`^${TOOL_OUTPUT_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`), "")
        .trim();
      return [{ kind: "stdout", ts, text: stripped }];
    }
    // Still in tool args — suppress
    return [];
  }

  if (lastWasProse && !inPreToolBlock) {
    if (isToolInvocationLine(trimmed)) {
      inPreToolBlock = true;
      lastWasProse = false;
      return [];
    }
  }

  // ── Bare line = actual assistant output ────────────────────────────────
  // In quiet mode, all ┊ lines are internal activity (tools, inner thoughts).
  // Bare lines are the assistant's final "out loud" response.
  lastWasProse = true;
  return [{ kind: "assistant", ts, text: trimmed }];
}
