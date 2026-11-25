import fs from "node:fs";
import { getUnresolvedBlockingFindings } from "./schema-validate.ts";
import type { RunLiveActivity, RunRecord, SwarmPostPayload } from "./types.ts";

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function compactText(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= 160) return line;
  return `${line.slice(0, 159).replace(/[\uD800-\uDBFF]$/, "")}…`;
}

function unwrapCommand(command: string): string {
  const body = command.replace(/^(?:\S*\/)?(?:bash|zsh|sh|dash|fish)\s+-[a-z]*c\s+/, "");
  const quote = body[0];
  return body !== command && (quote === "'" || quote === '"') && body.endsWith(quote)
    ? body.slice(1, -1)
    : body;
}

function summarizeEvent(event: Record<string, unknown>, item: Record<string, unknown> | undefined): string {
  const type = asText(event.type);
  switch (item?.type) {
    case "command_execution": {
      const command = asText(item.command);
      return command ? `Command ${unwrapCommand(command)}` : "Command execution";
    }
    case "file_change": {
      const paths = Array.isArray(item.changes)
        ? item.changes.map((change: unknown) => asText(asObject(change)?.path)).filter(Boolean)
        : [];
      return paths.length ? `File changes ${paths.join(", ")}` : "File changes";
    }
    case "agent_message": {
      const text = asText(item.text);
      return text ? `Agent message · ${text}` : "Agent message";
    }
    case "mcp_tool_call": {
      const tool = [asText(item.server), asText(item.tool)].filter(Boolean).join("/");
      return tool ? `MCP tool ${tool}` : "MCP tool call";
    }
    case "reasoning":
      return "Reasoning";
    case "web_search": {
      const query = asText(item.query);
      return query ? `Web search · ${query}` : "Web search";
    }
    case "error": {
      const message = asText(item.message);
      return message ? `Warning · ${message}` : "Warning";
    }
  }

  const message = asText(event.message) ?? asText(asObject(event.error)?.message) ?? asText(event.error)
    ?? asText(event.text) ?? asText(event.result);
  return [type, message].filter(Boolean).join(" · ") || "JSONL event";
}

export function inspectRunActivity(rawEventsPath: string, maxTailBytes = 65536): RunLiveActivity | null {
  let tail: string;
  let truncated: boolean;
  let updatedAt: string;
  try {
    const fd = fs.openSync(rawEventsPath, "r");
    try {
      const stat = fs.fstatSync(fd);
      updatedAt = stat.mtime.toISOString();
      const offset = Math.max(0, stat.size - maxTailBytes);
      truncated = offset > 0;
      // Include the preceding byte so a tail that starts exactly on a line boundary keeps that line.
      const start = truncated ? offset - 1 : offset;
      const buffer = Buffer.alloc(stat.size - start);
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, start);
      const firstNewline = truncated ? buffer.subarray(0, bytesRead).indexOf(0x0a) : -1;
      tail = truncated && firstNewline === -1 ? "" : buffer.toString("utf8", firstNewline + 1, bytesRead);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }

  let eventCount = 0;
  let lastEvent: Record<string, unknown> | undefined;
  for (const line of tail.split("\n")) {
    if (!line.trim()) continue;
    let event: Record<string, unknown> | undefined;
    try {
      event = asObject(JSON.parse(line));
    } catch {
      // The last write can end in the middle of a JSONL record.
      continue;
    }
    if (!event) continue;
    eventCount++;
    // A Codex item.completed warning only represents current activity until the next event.
    lastEvent = event;
  }

  const item = asObject(lastEvent?.item);
  return {
    event_count: eventCount,
    truncated,
    last_event_type: asText(lastEvent?.type) ?? null,
    last_item_type: asText(item?.type) ?? null,
    summary: lastEvent ? compactText(summarizeEvent(lastEvent, item)) : "Waiting for JSONL events",
    updated_at: updatedAt,
  };
}

export function formatSwarmPost(
  run: RunRecord,
  opts: { mention?: string; done?: boolean } = {}
): SwarmPostPayload {
  const mention = opts.mention?.trim().replace(/^@+/, "").trim();
  const prefixParts: string[] = [];
  if (mention && /^[^\s@]+$/.test(mention)) prefixParts.push(`@${mention}`);
  if (opts.done) prefixParts.push("[done]");
  const header = `${run.backend} model=${run.model ?? "default"} effort=${run.effort ?? "default"} cmd=${run.command} round=${run.round}/${run.max_rounds} run_id=${run.run_id}`;
  const lines = [
    prefixParts.length ? `${prefixParts.join(" ")} ${header}` : header,
    `execution=${run.execution_status} acceptance=${run.acceptance_status} freshness=${run.freshness_status} verdict_valid=${run.verdict_valid}`,
  ];

  const addList = (label: string, values: string[]) => {
    const visible = values.slice(0, 4).map(compactText).join(", ");
    const remaining = values.length > 4 ? ` (+${values.length - 4} more)` : "";
    lines.push(`${label} (${values.length})${visible ? ` · ${visible}${remaining}` : ""}`);
  };

  const output = run.parsed_output;
  if (output) {
    lines.push(compactText(output.summary));
    if ("findings" in output) {
      const unresolved = getUnresolvedBlockingFindings(output.findings, run.dispositions);
      addList("Blocking findings", unresolved.map((finding) => `${finding.id} ${finding.title}`));
    } else {
      addList("Modified files", output.modified_files);
      addList("Tests run", output.tests_run);
      if (output.open_issues.length) addList("Open issues", output.open_issues);
    }
  }

  if (run.failure_kind || run.failure_message) {
    lines.push(`Failure · ${compactText([run.failure_kind, run.failure_message].filter(Boolean).join(" · "))}`);
  }
  if (run.boundary_violation) addList("Boundary violations", run.boundary_violations);
  if (run.execution_status === "partial") addList("Changed files", run.changed_files);
  if (run.execution_status === "running") {
    const activity = inspectRunActivity(run.raw_events_path);
    if (activity) {
      const count = `${activity.event_count} ${activity.event_count === 1 ? "event" : "events"}`;
      const window = activity.truncated ? " in tail" : "";
      lines.push(`Activity · ${activity.summary} (${count}${window}, ${activity.updated_at})`);
    } else {
      lines.push("Activity · Waiting for JSONL events");
    }
  }

  return {
    run_id: run.run_id,
    task_id: run.task_id,
    command: run.command,
    backend: run.backend,
    model: run.model,
    effort: run.effort,
    execution_status: run.execution_status,
    acceptance_status: run.acceptance_status,
    post: lines.join("\n"),
  };
}
