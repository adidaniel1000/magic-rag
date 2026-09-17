import path from "node:path";
import { unified } from "unified";
import remarkParse from "remark-parse";
import rehypeParse from "rehype-parse";
import mammoth from "mammoth";
import ts from "typescript";
import * as yauzl from "yauzl";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import {
  AppError,
  type ParsedDocument,
  type Section,
  type DocumentParser,
} from "@secondmind/core";

const codeExtensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".cs",
  ".cpp",
  ".c",
  ".h",
  ".hpp",
  ".rb",
  ".php",
  ".swift",
  ".kt",
  ".sql",
  ".sh",
  ".ps1",
  ".yaml",
  ".yml",
  ".toml",
  ".xml",
  ".css",
  ".scss",
  ".vue",
  ".svelte",
]);
const extensions = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".json",
  ".html",
  ".htm",
  ".pdf",
  ".docx",
  ...codeExtensions,
]);
const textOf = (node: any): string =>
  node.value ?? (node.children || []).map(textOf).join("");
const lines = (text: string) => text.split("\n").length;

/** Bounded worker for untrusted documents; no parser work runs on the HTTP thread. */
export class ParserWorker {
  private worker?: Worker;
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private rejectCurrent?: (e: Error) => void;
  constructor(
    private filename: string,
    private timeout = 30000,
  ) {}
  parse(
    bytes: Uint8Array,
    name: string,
    maxChars: number,
  ): Promise<ParsedDocument> {
    const operation = this.queue
      .catch(() => {})
      .then(
        () =>
          new Promise<ParsedDocument>((resolve, reject) => {
            if (this.closed) {
              reject(new AppError("parser_stopped", "Parser stopped."));
              return;
            }
            const worker =
              this.worker ||
              (this.worker = new Worker(this.filename, {
                resourceLimits: { maxOldGenerationSizeMb: 512 },
              }));
            worker.removeAllListeners("error");
            worker.removeAllListeners("exit");
            let settled = false;
            const finish = (error?: Error, result?: ParsedDocument) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              worker.removeAllListeners("message");
              worker.removeAllListeners("error");
              worker.removeAllListeners("exit");
              const retire = () => {
                if (this.worker === worker) this.worker = undefined;
              };
              worker.once("error", retire);
              worker.once("exit", retire);
              this.rejectCurrent = undefined;
              error ? reject(error) : resolve(result!);
            };
            const timer = setTimeout(() => {
              this.worker = undefined;
              void worker.terminate();
              finish(
                new AppError(
                  "parser_timeout",
                  "File parsing exceeded the time limit.",
                ),
              );
            }, this.timeout);
            this.rejectCurrent = (error) => finish(error);
            worker.once("message", (message) =>
              finish(
                message.error
                  ? new AppError(message.code || "parser", message.error)
                  : undefined,
                message.result,
              ),
            );
            worker.once("error", () => {
              this.worker = undefined;
              finish(
                new AppError(
                  "parser_failure",
                  "Document parser failed. The file was skipped.",
                ),
              );
            });
            worker.once("exit", () => {
              this.worker = undefined;
              finish(
                new AppError(
                  "parser_failure",
                  "Document parser stopped. The file was skipped.",
                ),
              );
            });
            const input = Uint8Array.from(bytes);
            worker.postMessage({ bytes: input, name, maxChars }, [
              input.buffer,
            ]);
          }),
      );
    this.queue = operation;
    return operation;
  }
  async close() {
    this.closed = true;
    this.rejectCurrent?.(new AppError("parser_stopped", "Parser stopped."));
    if (this.worker) await this.worker.terminate();
    this.worker = undefined;
  }
}

export async function inspectDocx(bytes: Uint8Array) {
  await new Promise<void>((resolve, reject) => {
    yauzl.fromBuffer(Buffer.from(bytes), { lazyEntries: true }, (err, zip) => {
      if (err || !zip) {
        reject(new AppError("invalid_docx", "DOCX archive is invalid."));
        return;
      }
      let count = 0,
        expanded = 0;
      const fail = () => {
        zip.close();
        reject(
          new AppError(
            "archive_limits",
            "DOCX exceeds archive expansion limits.",
          ),
        );
      };
      zip.on("error", reject);
      zip.on("end", resolve);
      zip.on("entry", (entry) => {
        count++;
        expanded += entry.uncompressedSize;
        if (
          count > 10000 ||
          expanded > 200 * 1024 * 1024 ||
          entry.uncompressedSize >
            Math.max(1024 * 1024, entry.compressedSize * 200)
        ) {
          fail();
          return;
        }
        zip.readEntry();
      });
      zip.readEntry();
    });
  });
}

export class Parsers implements DocumentParser {
  constructor(public maxChars = 10000000) {}
  supports(extension: string) {
    return extensions.has(extension.toLowerCase());
  }
  private checked(doc: ParsedDocument) {
    if (doc.sections.reduce((n, s) => n + s.text.length, 0) > this.maxChars)
      throw new AppError(
        "text_limit",
        "Extracted document exceeds the configured text limit.",
      );
    return doc;
  }
  async parse(bytes: Uint8Array, filename: string): Promise<ParsedDocument> {
    const ext = path.extname(filename).toLowerCase(),
      title = path.basename(filename);
    if (ext === ".pdf") {
      const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const assets = path
        .dirname(fileURLToPath(import.meta.resolve("pdfjs-dist/package.json")))
        .replaceAll("\\", "/");
      const loading = getDocument({
        data: new Uint8Array(bytes),
        useSystemFonts: false,
        stopAtErrors: true,
        standardFontDataUrl: assets + "/standard_fonts/",
        cMapUrl: assets + "/cmaps/",
        cMapPacked: true,
        wasmUrl: assets + "/wasm/",
      });
      try {
        const pdf = await loading.promise;
        if (pdf.numPages > 10000)
          throw new AppError("pages_limit", "PDF has too many pages.");
        const sections: Section[] = [];
        let length = 0;
        for (let page = 1; page <= pdf.numPages; page++) {
          const p = await pdf.getPage(page);
          const content = await p.getTextContent();
          const text = content.items
            .map((item: any) => (item.str || "") + (item.hasEOL ? "\n" : " "))
            .join("")
            .trim();
          length += text.length;
          if (length > this.maxChars)
            throw new AppError(
              "text_limit",
              "PDF exceeds the extracted text limit.",
            );
          if (text) sections.push({ text, location: { page }, kind: "page" });
          p.cleanup();
        }
        if (!sections.length)
          throw new AppError(
            "ocr_required",
            "This PDF has no extractable text. OCR is not supported in this beta.",
          );
        return this.checked({ title, sections });
      } finally {
        await loading.destroy();
      }
    }
    if (ext === ".docx") {
      await inspectDocx(bytes);
      const html = await mammoth.convertToHtml(
        { buffer: Buffer.from(bytes) },
        {
          externalFileAccess: false,
          convertImage: mammoth.images.imgElement(async () => ({ src: "" })),
        },
      );
      return this.checked(this.html(html.value, title));
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new AppError(
        "encoding",
        "Text must be UTF-8. Save the file as UTF-8 and retry.",
      );
    }
    if (text.includes("\0"))
      throw new AppError("binary", "Binary content is not supported.");
    if (text.length > this.maxChars)
      throw new AppError(
        "text_limit",
        "Document exceeds the configured text limit.",
      );
    if (ext === ".html" || ext === ".htm")
      return this.checked(this.html(text, title));
    if (ext === ".md" || ext === ".markdown") {
      const tree: any = unified().use(remarkParse).parse(text);
      const sections: Section[] = [];
      let heading = "";
      for (const node of tree.children) {
        if (node.type === "heading") heading = textOf(node);
        if (node.type === "html" && /<(script|style)\b/i.test(node.value))
          continue;
        const start = node.position.start,
          end = node.position.end;
        sections.push({
          text: text.slice(start.offset, end.offset),
          location: { heading, line_start: start.line, line_end: end.line },
          kind: node.type,
        });
      }
      return this.checked({
        title: tree.children.find(
          (n: any) => n.type === "heading" && n.depth === 1,
        )
          ? textOf(
              tree.children.find(
                (n: any) => n.type === "heading" && n.depth === 1,
              ),
            )
          : title,
        sections,
      });
    }
    if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext))
      return this.checked(this.code(text, filename));
    if (ext === ".json") {
      try {
        JSON.parse(text);
      } catch {
        throw new AppError("invalid_json", "Invalid JSON document.");
      }
    }
    const sections: Section[] = [];
    const paragraphs = text.split(/(\n\s*\n)/);
    let line = 1;
    for (let i = 0; i < paragraphs.length; i += 2) {
      const paragraph = paragraphs[i];
      if (paragraph.trim())
        sections.push({
          text: paragraph,
          location: { line_start: line, line_end: line + lines(paragraph) - 1 },
          kind: codeExtensions.has(ext) ? "code_block" : "paragraph",
        });
      line += lines(paragraph + (paragraphs[i + 1] || "")) - 1;
    }
    return this.checked({
      title,
      sections,
      language: codeExtensions.has(ext) ? ext.slice(1) : undefined,
    });
  }
  private html(text: string, title: string): ParsedDocument {
    const tree: any = unified().use(rehypeParse).parse(text);
    const sections: Section[] = [];
    let heading = "";
    function visible(n: any): string {
      if (
        n.type === "element" &&
        ["script", "style", "noscript", "iframe", "svg"].includes(n.tagName)
      )
        return "";
      if (n.type === "text") return n.value;
      const inner = (n.children || [])
        .map(visible)
        .join(n.tagName === "tr" ? " | " : "");
      if (n.tagName === "a" && n.properties?.href)
        return `${inner} (${String(n.properties.href)})`;
      return inner + (["br", "p", "li", "tr"].includes(n.tagName) ? "\n" : "");
    }
    function walk(n: any) {
      if (
        n.type === "element" &&
        ["script", "style", "noscript", "iframe", "svg"].includes(n.tagName)
      )
        return;
      if (/^h[1-6]$/.test(n.tagName || "")) {
        heading = visible(n).trim();
        if (n.tagName === "h1") title = heading || title;
      }
      if (
        [
          "p",
          "pre",
          "table",
          "ul",
          "ol",
          "h1",
          "h2",
          "h3",
          "h4",
          "h5",
          "h6",
        ].includes(n.tagName)
      ) {
        const value = visible(n).trim();
        if (value)
          sections.push({
            text: value,
            location: {
              heading,
              line_start: n.position?.start.line,
              line_end: n.position?.end.line,
            },
            kind: n.tagName,
          });
        return;
      }
      if (n.type === "text" && n.value.trim())
        sections.push({
          text: n.value.trim(),
          location: { heading },
          kind: "paragraph",
        });
      else for (const child of n.children || []) walk(child);
    }
    walk(tree);
    return { title, sections };
  }
  private code(text: string, filename: string): ParsedDocument {
    const ast = ts.createSourceFile(
      filename,
      text,
      ts.ScriptTarget.Latest,
      true,
    );
    const sections: Section[] = [];
    const imports: string[] = [];
    const add = (
      node: ts.Node,
      kind: string,
      symbol?: string,
      start = node.getFullStart(),
      end = node.end,
    ) => {
      const value = text.slice(start, end);
      if (!value.trim()) return;
      sections.push({
        text: value,
        location: {
          symbol,
          symbol_type: kind,
          line_start: ast.getLineAndCharacterOfPosition(start).line + 1,
          line_end: ast.getLineAndCharacterOfPosition(end).line + 1,
        },
        kind,
      });
    };
    let consumed = 0;
    for (const node of ast.statements) {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        imports.push(node.moduleSpecifier.text);
      if (ts.isClassDeclaration(node) && node.members.length) {
        add(
          node,
          "class",
          node.name?.text,
          node.getFullStart(),
          node.members[0].getFullStart(),
        );
        for (const member of node.members)
          add(
            member,
            "method",
            `${node.name?.text || "anonymous"}.${member.name?.getText(ast) || "constructor"}`,
          );
        add(
          node,
          "class",
          node.name?.text,
          node.members[node.members.length - 1].end,
          node.end,
        );
      } else {
        const name =
          (node as any).name?.getText(ast) ||
          (ts.isVariableStatement(node)
            ? node.declarationList.declarations
                .map((d) => d.name.getText(ast))
                .join(", ")
            : undefined);
        add(
          node,
          ts.isFunctionDeclaration(node)
            ? "function"
            : ts.isInterfaceDeclaration(node)
              ? "interface"
              : "module",
          name,
        );
      }
      consumed = node.end;
    }
    if (consumed < text.length)
      add(ast, "module", undefined, consumed, text.length);
    return {
      title: path.basename(filename),
      sections,
      language: /\.[mc]?jsx?$/.test(filename) ? "javascript" : "typescript",
      imports,
    };
  }
}
