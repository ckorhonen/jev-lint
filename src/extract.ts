// Turns a Claude Code / Codex PostToolUse hook event into the code the edit added.

export type ChangedFile = { filePath: string; addedCode: string; changeKind: "write" | "edit" | "patch" };

type HookEvent = {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
};

export function extractChanges(event: HookEvent): ChangedFile[] {
  const input = event.tool_input ?? {};
  const filePath = typeof input.file_path === "string" ? input.file_path : "";

  switch (event.tool_name) {
    case "Write":
      return filePath && typeof input.content === "string" ? [{ filePath, addedCode: input.content, changeKind: "write" }] : [];
    case "Edit":
      return filePath && typeof input.new_string === "string" ? [{ filePath, addedCode: input.new_string, changeKind: "edit" }] : [];
    case "MultiEdit": {
      const edits = Array.isArray(input.edits) ? input.edits : [];
      const added = edits
        .map((e: { new_string?: unknown }) => (typeof e.new_string === "string" ? e.new_string : ""))
        .filter(Boolean)
        .join("\n\n");
      return filePath && added ? [{ filePath, addedCode: added, changeKind: "edit" }] : [];
    }
    case "apply_patch": {
      const patch = typeof input.command === "string" ? input.command : typeof input.patch === "string" ? input.patch : "";
      return parseApplyPatch(patch);
    }
    default:
      return [];
  }
}

// Codex apply_patch format: "*** Add File: p" / "*** Update File: p" sections whose
// "+" lines are the added code. Deleted files and "-"/context lines are ignored.
export function parseApplyPatch(patch: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  let current: { filePath: string; lines: string[] } | null = null;

  const flush = () => {
    if (current && current.lines.length) {
      files.push({ filePath: current.filePath, addedCode: current.lines.join("\n"), changeKind: "patch" });
    }
    current = null;
  };

  for (const line of patch.split(/\r?\n/)) {
    const header = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
    if (header) {
      flush();
      if (header[1] !== "Delete") current = { filePath: header[2].trim(), lines: [] };
      continue;
    }
    if (line.startsWith("*** ")) continue; // Begin/End Patch, Move to
    if (current && line.startsWith("+")) current.lines.push(line.slice(1));
  }
  flush();
  return files;
}
