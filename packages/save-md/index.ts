// Derived from Joey Gibson's save extension:
// https://github.com/joeygibson/pi-extensions/blob/main/extensions/save.ts
// Original code licensed under the MIT License.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, resolve } from "node:path";

type Role = "user" | "assistant";

type SavedMessage = {
  role: Role;
  text: string;
};

function textContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        typeof block === "object" &&
        block !== null &&
        "type" in block &&
        block.type === "text" &&
        "text" in block &&
        typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("\n\n")
    .trim();
}

function parseArgs(args: string | undefined): {
  filepath?: string;
  messageCount: number;
} {
  const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
  let filepath: string | undefined;
  let messageCount = 1;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token === "-n" || token === "--messages") {
      const value = tokens[++i];
      const parsed = Number.parseInt(value ?? "", 10);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error("--messages must be a positive integer.");
      }
      messageCount = parsed;
      continue;
    }

    if (token.startsWith("--messages=")) {
      const parsed = Number.parseInt(token.slice("--messages=".length), 10);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error("--messages must be a positive integer.");
      }
      messageCount = parsed;
      continue;
    }

    if (!filepath) {
      filepath = token;
      continue;
    }

    throw new Error(`Unexpected argument: ${token}`);
  }

  return { filepath, messageCount };
}

function localTimestamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");

  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("") +
    "-" +
    [pad(date.getHours()), pad(date.getMinutes())].join("");
}

function filenameSafeTitle(text: string, maxLength = 48): string {
  const firstLine =
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? "response";

  const cleaned = firstLine
    .replace(/^#{1,6}\s+/, "")
    .replace(/^>\s*/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength)
    .replace(/[\s.]+$/g, "");

  return cleaned || "response";
}

function withTimestamp(filepath: string, timestamp: string): string {
  const extension = extname(filepath);

  if (!extension) {
    return `${filepath}-${timestamp}.md`;
  }

  return `${filepath.slice(0, -extension.length)}-${timestamp}${extension}`;
}

function formatMarkdown(messages: SavedMessage[]): string {
  if (messages.length === 1 && messages[0].role === "assistant") {
    return `${messages[0].text}\n`;
  }

  return `${messages
    .map((message) => {
      const heading = message.role === "user" ? "User" : "Assistant";
      return `## ${heading}\n\n${message.text}`;
    })
    .join("\n\n")}\n`;
}

export default function saveMdExtension(pi: ExtensionAPI) {
  pi.registerCommand("save", {
    description:
      "Save the latest assistant response and optional recent messages as Markdown",
    handler: async (args, ctx) => {
      try {
        await ctx.waitForIdle();

        const { filepath: requestedPath, messageCount } = parseArgs(args);
        const branch = ctx.sessionManager.getBranch();

        const messages: SavedMessage[] = branch
          .filter(
            (entry) =>
              entry.type === "message" &&
              (entry.message.role === "user" ||
                entry.message.role === "assistant"),
          )
          .map((entry) => ({
            role: entry.message.role as Role,
            text: textContent(entry.message.content),
          }))
          .filter((message) => message.text.length > 0);

        const lastAssistantIndex = messages.findLastIndex(
          (message) => message.role === "assistant",
        );

        if (lastAssistantIndex < 0) {
          ctx.ui.notify("No assistant message found.", "warning");
          return;
        }

        const start = Math.max(0, lastAssistantIndex - messageCount + 1);
        const selected = messages.slice(start, lastAssistantIndex + 1);

        const title = filenameSafeTitle(selected[0].text);
        const timestamp = localTimestamp();
        let filepath = withTimestamp(requestedPath ?? title, timestamp);

        if (filepath.startsWith("~/") || filepath === "~") {
          filepath = filepath.replace("~", homedir());
        }

        const absolutePath = resolve(ctx.cwd, filepath);
        await mkdir(dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, formatMarkdown(selected), {
          encoding: "utf8",
          flag: "wx",
        });

        ctx.ui.notify(`Saved to ${filepath}`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Save failed: ${message}`, "error");
      }
    },
  });
}
