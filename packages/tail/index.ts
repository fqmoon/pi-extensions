// Derived from Joey Gibson's save extension:
// https://github.com/joeygibson/pi-extensions/blob/main/extensions/save.ts
// Original code licensed under the MIT License.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

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

function parseMessageCount(args: string | undefined): number {
  const value = (args ?? "").trim();

  if (!value) {
    return 1;
  }

  if (!/^\d+$/.test(value)) {
    throw new Error("Message count must be a positive integer.");
  }

  const count = Number.parseInt(value, 10);
  if (count < 1) {
    throw new Error("Message count must be a positive integer.");
  }

  return count;
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

function generateFilename(text: string, timestamp: string): string {
  return `${filenameSafeTitle(text)}-${timestamp}.md`;
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

export default function tailExtension(pi: ExtensionAPI) {
  pi.registerCommand("tail", {
    description:
      "Save the tail of the current conversation as Markdown",
    handler: async (args, ctx) => {
      try {
        await ctx.waitForIdle();

        const messageCount = parseMessageCount(args);
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

        const filepath = generateFilename(selected[0].text, localTimestamp());
        const absolutePath = resolve(ctx.cwd, filepath);

        await mkdir(dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, formatMarkdown(selected), {
          encoding: "utf8",
          flag: "wx",
        });

        ctx.ui.notify(`Saved to ${filepath}`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Tail failed: ${message}`, "error");
      }
    },
  });
}
