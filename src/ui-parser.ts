/**
 * Self-contained UI stdout parser for the Hermes Agent adapter.
 *
 * This file is designed to be served to the Paperclip UI for dynamic loading.
 * It has ZERO external runtime imports — all constants are inlined.
 *
 * Usage (by Paperclip UI):
 *   const { createStdoutParser } = await import("./ui-parser.js");
 *   const parser = createStdoutParser();
 *   const entries = parser.parseLine(line, timestamp);
 *
 * The exported `createStdoutParser()` factory returns a stateful parser
 * (tracks multi-line command continuation across calls).
 */

// ── Inlined constants (no imports) ─────────────────────────────────────────

const TOOL_OUTPUT_PREFIX = "\u250A"; // ┊
const PAPERCLIP_TRANSCRIPT_EVENT_PREFIX = "__PAPERCLIP_TRANSCRIPT__ ";

// ── Kaomoji / noise stripping ──────────────────────────────────────────────

function stripKaomoji(text: string): string {
  return text.replace(/[(][^()]{2,20}[)]\s*/gu, "").trim();
}

// ── Line classification ────────────────────────────────────────────────────

function isAssistantToolLine(stripped: string): boolean {
  return /^┊\s*💬/.test(stripped);
}

function extractAssistantText(line: string): string {
  return line.replace(/^[\s┊]*💬\s*/, "").trim();
}

// ── Tool completion parsing ────────────────────────────────────────────────

interface ToolCompletion {
  name: string;
  detail: string;
  duration: string;
  hasError: boolean;
}

function parseToolCompletionLine(line: string): ToolCompletion | null {
  let cleaned = line.trim().replace(/^\[done\]\s*/, "");
  if (!cleaned.startsWith(TOOL_OUTPUT_PREFIX)) return null;

  cleaned = cleaned.slice(TOOL_OUTPUT_PREFIX.length);
  cleaned = stripKaomoji(cleaned).trim();
  cleaned = cleaned.replace(/^(?:\p{Emoji_Presentation}|\p{Extended_Pictographic})\s+/u, "").trim();

  const durationMatch = cleaned.match(/([\d.]+s)\s*(?:\([\d.]+s\))?\s*$/);
  const duration = durationMatch ? durationMatch[1] : "";

  let verbAndDetail = durationMatch
    ? cleaned.slice(0, cleaned.lastIndexOf(durationMatch[0])).trim()
    : cleaned;

  const hasError =
    /\[(?:exit \d+|error|full)\]/.test(verbAndDetail) ||
    /\[error\]\s*$/.test(cleaned);

  const parts = verbAndDetail.match(/^(\S+)\s+(.*)/);
  if (!parts) return { name: "tool", detail: verbAndDetail, duration, hasError };

  const verb = parts[1];
  const detail = parts[2].trim();

  const nameMap: Record<string, string> = {
    $: "terminal",
    exec: "terminal",
    terminal: "terminal",
    search: "web_search",
    fetch: "web_extract",
    crawl: "web_crawl",
    navigate: "browser_navigate",
    snapshot: "browser_snapshot",
    click: "browser_click",
    type: "browser_type",
    scroll: "browser_scroll",
    back: "browser_back",
    press: "browser_press",
    close: "browser_close",
    images: "browser_get_images",
    vision: "browser_vision",
    read: "read_file",
    write: "write_file",
    patch: "patch",
    grep: "search_files",
    find: "search_files",
    plan: "todo",
    recall: "session_search",
    proc: "process",
    delegate: "delegate",
    todo: "todo",
    memory: "memory",
    clarify: "clarify",
    session_search: "session_search",
    code: "execute",
    execute: "execute",
    web_search: "web_search",
    web_extract: "web_extract",
    browser_navigate: "browser_navigate",
    browser_click: "browser_click",
    browser_type: "browser_type",
    browser_snapshot: "browser_snapshot",
    browser_vision: "browser_vision",
    browser_scroll: "browser_scroll",
    browser_press: "browser_press",
    browser_back: "browser_back",
    browser_close: "browser_close",
    browser_get_images: "browser_get_images",
    read_file: "read_file",
    write_file: "write_file",
    search_files: "search_files",
    patch_file: "patch",
    execute_code: "execute",
  };

  const name = nameMap[verb.toLowerCase()] || verb;
  return { name, detail, duration, hasError };
}

// ── Stateful parser ────────────────────────────────────────────────────────

let toolCallCounter = 0;

function syntheticToolUseId(): string {
  return `hermes-tool-${++toolCallCounter}`;
}

function compactToolDetail(detail: string, maxLength = 96): string {
  const oneLine = detail.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxLength) return oneLine;
  return `${oneLine.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function displayToolName(toolInfo: ToolCompletion): string {
  const detail = compactToolDetail(toolInfo.detail);
  return detail ? `${toolInfo.name}: ${detail}` : toolInfo.name;
}

function isThinkingLine(line: string): boolean {
  return (
    line.includes("\uD83D\uDCAD") ||
    line.startsWith("<thinking>") ||
    line.startsWith("</thinking>") ||
    line.startsWith("Thinking:")
  );
}

// ── Public API ─────────────────────────────────────────────────────────────

export interface TranscriptEntry {
  kind: "system" | "stderr" | "thinking" | "tool_call" | "tool_result" | "assistant" | "stdout" | "diff";
  ts: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  toolUseId?: string;
  toolName?: string;
  content?: string;
  isError?: boolean;
  delta?: boolean;
  changeType?: "add" | "remove" | "context" | "hunk" | "file_header" | "truncation";
}

export interface StdoutParser {
  /** Parse a single line of Hermes stdout into transcript entries. */
  parseLine(line: string, ts: string): TranscriptEntry[];
  /** Reset internal state (e.g., between runs). */
  reset(): void;
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
      kind: "tool_call",
      ts,
      name,
      input: (payload.input && typeof payload.input === "object" && !Array.isArray(payload.input))
        ? payload.input as Record<string, unknown>
        : {},
      toolUseId,
    }];
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
      kind: "tool_result",
      ts,
      toolUseId,
      toolName,
      content: typeof payload.content === "string" ? payload.content : String(payload.content ?? ""),
      isError: payload.isError === true,
    }];
  }

  return [];
}

/**
 * Create a stateful stdout parser instance.
 *
 * Each call returns a fresh parser with its own continuation-tracking state.
 * This is important because the parser is a singleton module in the browser —
 * multiple concurrent runs must not share continuation state.
 */
export function createStdoutParser(): StdoutParser {
  let suppressContinuation = false;
  let inDiffBlock = false;
  let structuredResultsPendingCute = 0;
  const pendingStructuredToolUseIds: string[] = [];

  // ── Pre-tool-invocation suppression ────────────────────────────────────
  let lastWasProse = false;
  let inPreToolBlock = false;

  function isToolInvocationLine(line: string): boolean {
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

  function classifyDiffLine(trimmed: string): TranscriptEntry | null {
    // Hunk header: @@ -X,Y +X,Y @@
    if (/^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/.test(trimmed)) {
      return null; // Skip hunk headers — they're noise for the UI
    }
    // File header: a/path → b/path
    if (/^a\/.*→.*b\//.test(trimmed)) {
      return { kind: "diff", ts: "", changeType: "file_header", text: trimmed.replace(/^a\//, "").replace(/\s*→.*$/, "") };
    }
    // Truncation notice: "… omitted N diff line(s) across M additional file(s)/section(s)"
    if (/^…\s*omitted/.test(trimmed)) {
      return { kind: "diff", ts: "", changeType: "truncation", text: trimmed };
    }
    // Removal (but not --- which is the old-file marker in a file header)
    if (/^-/.test(trimmed) && !/^---/.test(trimmed)) {
      return { kind: "diff", ts: "", changeType: "remove", text: trimmed.slice(1) };
    }
    // Addition (but not +++ which is the new-file marker)
    if (/^\+/.test(trimmed) && !/^\+\+\+/.test(trimmed)) {
      return { kind: "diff", ts: "", changeType: "add", text: trimmed.slice(1) };
    }
    // Context line (bare code, no prefix)
    return { kind: "diff", ts: "", changeType: "context", text: trimmed };
  }

  function parseLine(line: string, ts: string): TranscriptEntry[] {
    const trimmed = line.trim();

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

    // ── Hermes box-drawing banner (╭─ ⚕ Hermes ── / ╰── / │ content) ──
    if (/^╭[─┄┈┅┆│ ⚕]/.test(trimmed) || /^╰[─┄┈┅┆│]/.test(trimmed) || /^│/.test(trimmed)) {
      return [];
    }

    if (trimmed.startsWith("[hermes]") || trimmed.startsWith("[paperclip]")) {
      suppressContinuation = false;
      lastWasProse = false;
      return [{ kind: "system", ts, text: trimmed }];
    }

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

    if (/^\[\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
      suppressContinuation = false;
      lastWasProse = false;
      return [{ kind: "stderr", ts, text: trimmed }];
    }

    if (/^\p{Emoji_Presentation}\s*(Completed|Running|Error)?\s*$/u.test(trimmed)) {
      return [];
    }

    if (trimmed.startsWith("session_id:")) {
      suppressContinuation = false;
      lastWasProse = false;
      return [{ kind: "system", ts, text: trimmed }];
    }

    // ── Diff block detection ──────────────────────────────────────────
    // After "┊ review diff", subsequent non-┊ lines are diff content
    if (inDiffBlock) {
      if (trimmed.includes(TOOL_OUTPUT_PREFIX)) {
        inDiffBlock = false;
        // Fall through to normal ┊ handling below
      } else if (!trimmed) {
        return [];
      } else {
        const diff = classifyDiffLine(trimmed);
        return diff ? [{ ...diff, ts }] : [];
      }
    }

    // ── ┊-prefixed lines ──────────────────────────────────────────────
    if (trimmed.includes(TOOL_OUTPUT_PREFIX)) {
      if (isAssistantToolLine(trimmed)) {
        suppressContinuation = false;
        lastWasProse = true;
        return [{ kind: "thinking", ts, text: extractAssistantText(trimmed) }];
      }

      // Detect "┊ review diff" — signals start of diff output (no emoji/verb/duration)
      const afterPipe = trimmed.replace(/^┊\s*/, "").trim();
      if (/^review\s+diff$/.test(afterPipe)) {
        suppressContinuation = false;
        lastWasProse = false;
        inDiffBlock = true;
        return []; // Marker only — no visible output
      }

      const toolInfo = parseToolCompletionLine(trimmed);
      if (toolInfo) {
        const name = displayToolName(toolInfo);
        const detailText = toolInfo.duration
          ? `${toolInfo.detail}  ${toolInfo.duration}`
          : toolInfo.detail;
        suppressContinuation = true;
        lastWasProse = false;
        if (structuredResultsPendingCute > 0) {
          structuredResultsPendingCute -= 1;
          return [];
        }
        const pendingId = pendingStructuredToolUseIds.shift();
        if (pendingId) {
          return [
            { kind: "tool_result", ts, toolUseId: pendingId, toolName: name, content: detailText, isError: toolInfo.hasError },
          ];
        }
        const id = syntheticToolUseId();
        return [
          { kind: "tool_call", ts, name, input: { name: toolInfo.name, detail: toolInfo.detail }, toolUseId: id },
          { kind: "tool_result", ts, toolUseId: id, toolName: name, content: detailText, isError: toolInfo.hasError },
        ];
      }

      const stripped = trimmed
        .replace(/^\[done\]\s*/, "")
        .replace(new RegExp(`^${TOOL_OUTPUT_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`), "")
        .trim();
      suppressContinuation = false;
      lastWasProse = false;
      return [{ kind: "stdout", ts, text: stripped }];
    }

    // ── Multi-line continuation suppression ──────────────────────────
    if (suppressContinuation) {
      if (!trimmed) {
        suppressContinuation = false;
        return [];
      }
      // Bare duration line: "1.2s" or "'  1.2s" — end of tool body
      if (/^\s*\d+\.\d+s\s*$/.test(trimmed)) {
        suppressContinuation = false;
        return [];
      }
      if (/^["']\s*\d+\.\d+s\s*$/.test(trimmed)) {
        suppressContinuation = false;
        return [];
      }
      // Duration at end of a continuation line: '...json}'  1.2s
      if (/\d+\.\d+s\s*$/.test(trimmed) && /^(["']?\s*[-\\])/.test(trimmed)) {
        suppressContinuation = false;
        return [];
      }
      if (trimmed.startsWith(TOOL_OUTPUT_PREFIX)) {
        suppressContinuation = false;
        return [{ kind: "assistant", ts, text: trimmed }];
      }
      // Shell/curl continuation flags — NEVER prose
      if (/^[-\\]/.test(trimmed)) {
        return [];
      }
      const codeKeywords = [
        "import ", "from ", "const ", "let ", "var ", "if ", "for ",
        "while ", "def ", "class ", "return ", "print(",
      ];
      const looksLikeProse =
        /^[A-Z\"*#\d(]/.test(trimmed) &&
        !/[{}()\[\];:=]/.test(trimmed.slice(0, 20)) &&
        !codeKeywords.some((kw) => trimmed.startsWith(kw));
      if (looksLikeProse) {
        suppressContinuation = false;
        lastWasProse = true;
        return [{ kind: "assistant", ts, text: trimmed }];
      }
      return [];
    }

    // ── Thinking / Error / Default ────────────────────────────────────
    if (isThinkingLine(trimmed)) {
      return [{ kind: "thinking", ts, text: trimmed.replace(/^💭\s*/, "") }];
    }
    if (trimmed.startsWith("Error:") || trimmed.startsWith("ERROR:") || trimmed.startsWith("Traceback")) {
      lastWasProse = false;
      return [{ kind: "stderr", ts, text: trimmed }];
    }

    // ── Pre-tool-invocation suppression ─────────────────────────────
    if (inPreToolBlock) {
      if (!trimmed) {
        inPreToolBlock = false;
        return [];
      }
      if (trimmed.startsWith(TOOL_OUTPUT_PREFIX)) {
        inPreToolBlock = false;
        lastWasProse = false;
        const stripped = trimmed
          .replace(/^\[done\]\s*/, "")
          .replace(new RegExp(`^${TOOL_OUTPUT_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`), "")
          .trim();
        return [{ kind: "stdout", ts, text: stripped }];
      }
      return [];
    }

    if (lastWasProse && !inPreToolBlock) {
      if (isToolInvocationLine(trimmed)) {
        inPreToolBlock = true;
        lastWasProse = false;
        return [];
      }
    }

    lastWasProse = true;
    return [{ kind: "assistant", ts, text: trimmed }];
  }

  function reset(): void {
    suppressContinuation = false;
    inDiffBlock = false;
    structuredResultsPendingCute = 0;
    pendingStructuredToolUseIds.length = 0;
    lastWasProse = false;
    inPreToolBlock = false;
  }

  return { parseLine, reset };
}

/** Default singleton parser for simple usage. */
export const defaultParser: StdoutParser = createStdoutParser();

/**
 * Convenience: parse a line using the default singleton parser.
 * Matches the StdoutLineParser type signature expected by Paperclip UI.
 */
export function parseStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return defaultParser.parseLine(line, ts);
}
