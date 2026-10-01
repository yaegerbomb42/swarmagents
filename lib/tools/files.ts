import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { clip, type Tool } from "./types";

export const resolvePath = (p: string, cwd: string) => path.resolve(cwd, String(p).replace(/^~(?=$|\/)/, os.homedir()));

const IMAGE: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

function isBinary(buf: Buffer) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export const readFile: Tool = {
  spec: {
    name: "read_file",
    description:
      "Read a file of any size, paged by line (offset/limit). Images are returned visually. PDFs, Office docs and other formats are converted to text when possible. For huge files read in pages or grep first.",
    schema: {
      type: "object",
      properties: { path: { type: "string" }, offset: { type: "number", description: "1-based start line" }, limit: { type: "number", description: "Lines, default 2000" } },
      required: ["path"],
    },
  },
  async run(input, ctx) {
    const f = resolvePath(String(input.path), ctx.cwd);
    const st = fs.statSync(f);
    if (st.isDirectory()) {
      const items = fs.readdirSync(f, { withFileTypes: true }).map((d) => d.name + (d.isDirectory() ? "/" : ""));
      return { content: clip(items.join("\n")) };
    }
    const ext = path.extname(f).toLowerCase();
    if (IMAGE[ext] && st.size < 20_000_000) return { content: `Image ${f} (${st.size} bytes)`, images: [{ mediaType: IMAGE[ext], data: fs.readFileSync(f).toString("base64") }] };

    let text: string;
    if ([".pdf", ".docx", ".doc", ".rtf", ".pptx", ".xlsx", ".odt", ".pages"].includes(ext)) {
      // macOS ships textutil (docs) and mdimport/strings; pdftotext if the user has poppler.
      const r =
        ext === ".pdf"
          ? spawnSync("/bin/zsh", ["-lc", `pdftotext -layout ${JSON.stringify(f)} - 2>/dev/null || python3 -c "import sys;from pypdf import PdfReader;print('\\n'.join(p.extract_text() or '' for p in PdfReader(sys.argv[1]).pages))" ${JSON.stringify(f)} 2>/dev/null || mdls -raw -name kMDItemTextContent ${JSON.stringify(f)}`], { maxBuffer: 1 << 30 })
          : spawnSync("textutil", ["-convert", "txt", "-stdout", f], { maxBuffer: 1 << 30 });
      text = r.stdout?.toString() ?? "";
      if (!text.trim()) return { content: `Could not extract text from ${f}. Try the bash tool (e.g. pip install pypdf / brew install poppler).`, isError: true };
    } else {
      // Stream only what we need so multi-GB files are fine.
      const fd = fs.openSync(f, "r");
      const head = Buffer.alloc(Math.min(st.size, 8000));
      fs.readSync(fd, head, 0, head.length, 0);
      if (isBinary(head)) {
        fs.closeSync(fd);
        const r = spawnSync("file", ["-b", f]);
        return { content: `Binary file ${f} (${st.size} bytes): ${r.stdout?.toString().trim()}. Use bash (xxd, strings, unzip, sqlite3, …) to inspect.` };
      }
      fs.closeSync(fd);
      if (st.size > 50_000_000) {
        const offset = Math.max(1, Number(input.offset ?? 1));
        const limit = Number(input.limit ?? 2000);
        const r = spawnSync("sed", ["-n", `${offset},${offset + limit - 1}p`, f], { maxBuffer: 1 << 28 });
        const total = spawnSync("wc", ["-l", f]).stdout.toString().trim().split(/\s+/)[0];
        return { content: clip(number(r.stdout.toString().split("\n"), offset) + `\n[lines ${offset}-${offset + limit - 1} of ${total}]`, 60_000) };
      }
      text = fs.readFileSync(f, "utf8");
    }
    const lines = text.split("\n");
    const offset = Math.max(1, Number(input.offset ?? 1));
    const limit = Number(input.limit ?? 2000);
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const more = offset - 1 + limit < lines.length ? `\n[showing ${offset}-${offset + slice.length - 1} of ${lines.length} lines; use offset to continue]` : "";
    return { content: clip(number(slice, offset) + more, 60_000) };
  },
};

function number(lines: string[], start: number) {
  return lines.map((l, i) => `${String(start + i).padStart(6)}\t${l.length > 2000 ? l.slice(0, 2000) + "…" : l}`).join("\n");
}

export const writeFile: Tool = {
  spec: {
    name: "write_file",
    description: "Create or overwrite a file with the given content. Parent folders are created.",
    schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
  },
  async run(input, ctx) {
    const f = resolvePath(String(input.path), ctx.cwd);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const existed = fs.existsSync(f);
    fs.writeFileSync(f, String(input.content ?? ""));
    return { content: `${existed ? "Overwrote" : "Created"} ${f} (${String(input.content ?? "").split("\n").length} lines)` };
  },
};

export const editFile: Tool = {
  spec: {
    name: "edit_file",
    description:
      "Replace an exact string in a file. old_string must match exactly (including whitespace) and be unique unless replace_all is true. Read the file first.",
    schema: {
      type: "object",
      properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean" } },
      required: ["path", "old_string", "new_string"],
    },
  },
  async run(input, ctx) {
    const f = resolvePath(String(input.path), ctx.cwd);
    const src = fs.readFileSync(f, "utf8");
    const oldS = String(input.old_string);
    const newS = String(input.new_string);
    const count = oldS ? src.split(oldS).length - 1 : 0;
    if (!count) return { content: `old_string not found in ${f}. Re-read the file and match it exactly.`, isError: true };
    if (count > 1 && !input.replace_all) return { content: `old_string occurs ${count} times in ${f}. Add surrounding context or set replace_all.`, isError: true };
    const out = input.replace_all ? src.split(oldS).join(newS) : src.replace(oldS, () => newS);
    fs.writeFileSync(f, out);
    const line = src.slice(0, src.indexOf(oldS)).split("\n").length;
    return { content: `Edited ${f} (${count} replacement${count > 1 ? "s" : ""}, near line ${line})\n--- old\n${clip(oldS, 3000)}\n+++ new\n${clip(newS, 3000)}` };
  },
};

export const grep: Tool = {
  spec: {
    name: "search",
    description:
      "Fast code/text search with ripgrep. mode=content returns matching lines; mode=files lists matching files; set pattern to '' and glob to list files by name (e.g. glob='**/*.tsx').",
    schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex" },
        path: { type: "string" },
        glob: { type: "string" },
        mode: { type: "string", enum: ["content", "files"] },
        ignore_case: { type: "boolean" },
        context: { type: "number" },
      },
      required: ["pattern"],
    },
  },
  async run(input, ctx) {
    const dir = resolvePath(String(input.path ?? "."), ctx.cwd);
    const args = ["--color=never", "--max-columns=400", "--max-columns-preview"];
    if (input.glob) args.push("-g", String(input.glob));
    if (input.ignore_case) args.push("-i");
    const pattern = String(input.pattern ?? "");
    if (!pattern) args.push("--files");
    else {
      if (input.mode === "files") args.push("-l");
      else args.push("-n", ...(input.context ? ["-C", String(input.context)] : []));
      args.push("-e", pattern);
    }
    args.push(dir);
    const r = spawnSync("rg", args, { maxBuffer: 1 << 28, encoding: "utf8" });
    const out = (r.stdout || "").trim();
    if (!out) return { content: r.stderr?.trim() || "No matches." };
    const lines = out.split("\n");
    return { content: clip(lines.slice(0, 2000).join("\n") + (lines.length > 2000 ? `\n[${lines.length - 2000} more lines]` : ""), 40_000) };
  },
};
