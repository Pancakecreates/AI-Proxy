import type { AcpSessionUpdate } from "./types.js";

const TOOL_DETAIL_MAX_CHARS = 140;
const TOOL_OUTPUT_MAX_CHARS = 700;
const TOOL_PROGRESS_MAX_CHARS = 240;

type JsonObject = Record<string, unknown>;

interface ToolActivityState {
  title?: string;
  name?: string;
  kind?: string;
  detail?: string;
  status?: string;
  output: string;
  announcedStart: boolean;
  terminalEmitted: boolean;
  lastProgress?: string;
}

function asRecord(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function cleanText(text: string): string | null {
  const compact = text.split(/\s+/).filter(Boolean).join(" ");
  return compact || null;
}

function truncateFront(text: string, maxChars: number): string {
  const chars = [...text];
  return chars.length <= maxChars ? text : `${chars.slice(0, maxChars).join("")}…`;
}

function tailChars(text: string, maxChars: number): string {
  const chars = [...text];
  return chars.length <= maxChars ? text : chars.slice(chars.length - maxChars).join("");
}

function pushTail(buffer: string, addition: string, maxChars: number): string {
  if (!addition) return buffer;
  return tailChars(buffer + addition, maxChars);
}

function outputPreview(text: string): string | null {
  const compact = cleanText(text);
  if (!compact) return null;
  return [...compact].length <= TOOL_OUTPUT_MAX_CHARS ? compact : `…${tailChars(compact, TOOL_OUTPUT_MAX_CHARS)}`;
}

function normalizeStatus(status: string): string {
  return status.trim().toLowerCase().replaceAll("-", "_");
}

function statusIsStart(status: string): boolean {
  return status === "pending" || status === "in_progress" || status === "inprogress" || status === "running";
}

function statusIsTerminal(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "canceled";
}

function applyPatchString(update: JsonObject, key: string, state: ToolActivityState, field: "title" | "name" | "kind" | "status"): void {
  if (!(key in update)) return;
  const value = update[key];
  if (value === null) {
    delete state[field];
  } else {
    const text = asString(value);
    const clean = text ? cleanText(text) : null;
    if (clean) state[field] = clean;
  }
}

function rawInputDetail(rawInput: unknown): string | null {
  const direct = asString(rawInput);
  if (direct && cleanText(direct)) return truncateFront(cleanText(direct) ?? direct, TOOL_DETAIL_MAX_CHARS);
  const object = asRecord(rawInput);
  if (!object) return null;
  for (const key of ["command", "cmd", "path", "file_path", "filePath", "query", "url"]) {
    const value = object[key];
    const text = asString(value);
    if (text && cleanText(text)) return truncateFront(cleanText(text) ?? text, TOOL_DETAIL_MAX_CHARS);
    if (Array.isArray(value)) {
      const joined = value.filter((part): part is string => typeof part === "string").join(" ");
      const clean = cleanText(joined);
      if (clean) return truncateFront(clean, TOOL_DETAIL_MAX_CHARS);
    }
  }
  return null;
}

function locationsDetail(locations: unknown): string | null {
  if (!Array.isArray(locations)) return null;
  const paths = locations
    .map((entry) => asRecord(entry)?.path)
    .filter((path): path is string => typeof path === "string")
    .slice(0, 3);
  return paths.length ? truncateFront(paths.join(", "), TOOL_DETAIL_MAX_CHARS) : null;
}

function toolContentEntries(content: unknown): JsonObject[] {
  const values = Array.isArray(content) ? content : [content];
  return values.map(asRecord).filter((entry): entry is JsonObject => entry !== null);
}

function toolContentTexts(content: unknown): string[] {
  const out: string[] = [];
  for (const entry of toolContentEntries(content)) {
    if (entry.type === "content") {
      const inner = asRecord(entry.content);
      const direct = asString(inner?.text);
      if (direct) {
        out.push(direct);
        continue;
      }
      const resource = asRecord(inner?.resource);
      const resourceText = asString(resource?.text);
      if (resourceText) out.push(resourceText);
    } else {
      const text = asString(entry.text);
      if (text) out.push(text);
    }
  }
  return out;
}

function toolContentDiffDetail(content: unknown): string | null {
  const paths = new Set<string>();
  for (const entry of toolContentEntries(content)) {
    if (entry.type !== "diff") continue;
    const direct = asString(entry.path);
    if (direct) paths.add(direct);
    if (Array.isArray(entry.changes)) {
      for (const change of entry.changes) {
        const path = asRecord(change)?.path;
        if (typeof path === "string") paths.add(path);
      }
    }
  }
  const selected = [...paths].sort().slice(0, 3);
  return selected.length ? truncateFront(selected.join(", "), TOOL_DETAIL_MAX_CHARS) : null;
}

function jsonOutputText(value: unknown): string | null {
  const direct = asString(value);
  if (direct) return cleanText(direct);
  const object = asRecord(value);
  if (object) {
    for (const key of ["output", "text", "message", "error"]) {
      const text = asString(object[key]);
      const clean = text ? cleanText(text) : null;
      if (clean) return clean;
    }
    if (Array.isArray(object.content)) {
      const text = object.content
        .map((entry) => asRecord(entry)?.text)
        .filter((part): part is string => typeof part === "string")
        .join("\n");
      const clean = cleanText(text);
      if (clean) return clean;
    }
  }
  if (value === null || value === undefined) return null;
  try {
    return cleanText(JSON.stringify(value));
  } catch {
    return null;
  }
}

function formatActivityLine(backendLabel: string, state: ToolActivityState, terminal: boolean): string {
  const title = state.title ?? state.name ?? state.kind ?? "tool";
  const detail = state.detail && !title.includes(state.detail) ? ` — ${state.detail}` : "";
  if (!terminal) return `\n[${backendLabel} tool] ${title}${detail}...\n`;
  const status = state.status ?? "completed";
  const output = outputPreview(state.output);
  return `\n[${backendLabel} tool ${status}] ${title}${detail}${output ? `\n  output: ${output}` : ""}\n`;
}

function codexToolTitle(item: JsonObject): string {
  const kind = asString(item.type) ?? "tool";
  if (kind === "commandExecution") {
    const command = asString(item.command);
    const clean = command ? cleanText(command) : null;
    return clean ? `Run ${truncateFront(clean, 80)}` : "Run command";
  }
  if (kind === "fileChange") return "Edit files";
  if (kind === "mcpToolCall") {
    const server = asString(item.server) ?? "";
    const tool = asString(item.tool) ?? "mcp";
    return server ? `${server}.${tool}` : tool;
  }
  if (kind === "webSearch") {
    const query = asString(item.query);
    const clean = query ? cleanText(query) : null;
    return clean ? `Web search: ${truncateFront(clean, 60)}` : "Web search";
  }
  if (kind === "dynamicToolCall") {
    const namespace = asString(item.namespace) ?? "";
    const tool = asString(item.tool) ?? "Tool call";
    return namespace ? `${namespace}.${tool}` : tool;
  }
  return kind;
}

function codexToolDetail(item: JsonObject): string | null {
  if (item.type !== "fileChange" || !Array.isArray(item.changes)) return null;
  const paths = item.changes
    .map((change) => asRecord(change)?.path)
    .filter((path): path is string => typeof path === "string")
    .slice(0, 3);
  return paths.length ? truncateFront(paths.join(", "), TOOL_DETAIL_MAX_CHARS) : null;
}

function codexToolOutput(item: JsonObject): string | null {
  if (item.type === "commandExecution") {
    const output = asString(item.aggregatedOutput);
    return output ? cleanText(output) : null;
  }
  if (item.type === "mcpToolCall") {
    const error = asRecord(item.error);
    const errorMessage = asString(error?.message);
    if (errorMessage && cleanText(errorMessage)) return cleanText(errorMessage);
    return jsonOutputText(item.result);
  }
  if (item.type === "dynamicToolCall" && Array.isArray(item.contentItems)) {
    const text = item.contentItems
      .map((entry) => asRecord(entry)?.text)
      .filter((part): part is string => typeof part === "string")
      .join("\n");
    return cleanText(text);
  }
  return null;
}

export class ToolActivityTracker {
  readonly #states = new Map<string, ToolActivityState>();

  #state(id: string): ToolActivityState {
    let state = this.#states.get(id);
    if (!state) {
      state = { output: "", announcedStart: false, terminalEmitted: false };
      this.#states.set(id, state);
    }
    return state;
  }

  noteAcpContentChunk(update: AcpSessionUpdate): void {
    const id = update.toolCallId;
    if (!id) return;
    const state = this.#state(id);
    const detail = toolContentDiffDetail(update.content);
    if (detail && !state.detail) state.detail = detail;
    for (const text of toolContentTexts(update.content)) {
      state.output = pushTail(state.output, text, TOOL_OUTPUT_MAX_CHARS * 2);
    }
  }

  acpToolLine(backendLabel: string, update: AcpSessionUpdate): string | null {
    const raw = update as unknown as JsonObject;
    const id = update.toolCallId || update.title || update.name || "tool";
    const state = this.#state(id);

    applyPatchString(raw, "title", state, "title");
    applyPatchString(raw, "name", state, "name");
    applyPatchString(raw, "kind", state, "kind");
    applyPatchString(raw, "status", state, "status");

    if ("rawInput" in raw) {
      if (raw.rawInput === null) {
        delete state.detail;
      } else {
        const detail = rawInputDetail(raw.rawInput);
        if (detail) state.detail = detail;
      }
    }
    if ("locations" in raw) {
      if (raw.locations === null) {
        if (!("rawInput" in raw)) delete state.detail;
      } else if (!state.detail) {
        const detail = locationsDetail(raw.locations);
        if (detail) state.detail = detail;
      }
    }
    if ("content" in raw) {
      if (raw.content === null || (Array.isArray(raw.content) && raw.content.length === 0)) {
        state.output = "";
      } else {
        const texts = toolContentTexts(raw.content);
        state.output = "";
        for (const text of texts) state.output = pushTail(state.output, text, TOOL_OUTPUT_MAX_CHARS * 2);
        if (!state.detail) {
          const detail = toolContentDiffDetail(raw.content);
          if (detail) state.detail = detail;
        }
      }
    }
    if (!("content" in raw) && "rawOutput" in raw) {
      if (raw.rawOutput === null) {
        state.output = "";
      } else {
        const output = jsonOutputText(raw.rawOutput);
        if (output) state.output = tailChars(output, TOOL_OUTPUT_MAX_CHARS * 2);
      }
    }

    const status = normalizeStatus(state.status ?? "running");
    if (statusIsStart(status)) {
      if (state.announcedStart) return null;
      state.announcedStart = true;
      return formatActivityLine(backendLabel, state, false);
    }
    if (statusIsTerminal(status)) {
      if (state.terminalEmitted) return null;
      state.terminalEmitted = true;
      return formatActivityLine(backendLabel, state, true);
    }
    return null;
  }

  noteCodexOutput(itemId: string, output: string): void {
    if (!itemId || !output) return;
    const state = this.#state(itemId);
    state.output = pushTail(state.output, output, TOOL_OUTPUT_MAX_CHARS * 2);
  }

  codexProgressLine(backendLabel: string, itemId: string, message: string): string | null {
    const clean = cleanText(message);
    if (!clean) return null;
    const progress = truncateFront(clean, TOOL_PROGRESS_MAX_CHARS);
    const state = this.#state(itemId);
    if (state.lastProgress === progress) return null;
    state.lastProgress = progress;
    return `\n[${backendLabel} tool progress] ${progress}\n`;
  }

  codexToolLine(backendLabel: string, item: JsonObject, started: boolean): string | null {
    const itemType = asString(item.type) ?? "tool";
    const itemId = asString(item.id) ?? itemType;
    const state = this.#state(itemId);
    state.title = codexToolTitle(item);
    if (!state.detail) {
      const detail = codexToolDetail(item);
      if (detail) state.detail = detail;
    }
    const status = normalizeStatus(asString(item.status) ?? (started ? "in_progress" : "completed"));
    state.status = status;
    if (!started) {
      const output = codexToolOutput(item);
      if (output) state.output = tailChars(output, TOOL_OUTPUT_MAX_CHARS * 2);
    }

    if (statusIsStart(status)) {
      if (state.announcedStart) return null;
      state.announcedStart = true;
      return formatActivityLine(backendLabel, state, false);
    }
    if (statusIsTerminal(status)) {
      if (state.terminalEmitted) return null;
      state.terminalEmitted = true;
      return formatActivityLine(backendLabel, state, true);
    }
    return null;
  }
}

export class PlanActivityTracker {
  readonly #fingerprints = new Map<string, string>();

  acpPlanLine(backendLabel: string, update: AcpSessionUpdate): string | null {
    if (update.sessionUpdate === "plan_removed") {
      const planId = update.planId ?? "plan";
      const fingerprint = `removed:${planId}`;
      if (this.#fingerprints.get(planId) === fingerprint) return null;
      this.#fingerprints.set(planId, fingerprint);
      return `\n[${backendLabel} plan] plan removed\n`;
    }

    const legacyPlan: JsonObject | null =
      update.sessionUpdate === "plan"
        ? { type: "items", planId: "legacy", entries: Array.isArray(update.entries) ? update.entries : [] }
        : null;
    const plan = legacyPlan ?? asRecord(update.plan);
    if (!plan) return null;
    const planId = asString(plan.planId) ?? "plan";
    let fingerprint = "";
    try {
      fingerprint = JSON.stringify(plan);
    } catch {
      return null;
    }
    if (this.#fingerprints.get(planId) === fingerprint) return null;
    this.#fingerprints.set(planId, fingerprint);

    let summary = "plan updated";
    if (plan.type === "items" && Array.isArray(plan.entries)) {
      const entries = plan.entries.map(asRecord).filter((entry): entry is JsonObject => entry !== null);
      const total = entries.length;
      const done = entries.filter((entry) => {
        const status = asString(entry.status);
        return status === "completed" || status === "cancelled" || status === "canceled";
      }).length;
      const currentEntry =
        entries.find((entry) => asString(entry.status) === "in_progress") ??
        entries.find((entry) => asString(entry.status) === "pending");
      const current = currentEntry ? cleanText(asString(currentEntry.content) ?? "") : null;
      summary = total
        ? `${done}/${total} completed${current ? ` — ${truncateFront(current, 120)}` : ""}`
        : "plan updated";
    } else if (plan.type === "markdown") {
      const content = asString(plan.content) ?? "";
      const firstLine = content.split(/\r?\n/).find((line) => line.trim());
      const clean = firstLine ? cleanText(firstLine.replace(/^#+\s*/, "")) : null;
      if (clean) summary = truncateFront(clean, 160);
    } else if (plan.type === "file") {
      const uri = asString(plan.uri);
      if (uri) summary = `plan file: ${truncateFront(uri, 140)}`;
    }
    return `\n[${backendLabel} plan] ${summary}\n`;
  }
}
