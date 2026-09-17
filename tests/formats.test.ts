import { it, expect } from "vitest";
import { Parsers, ParserWorker } from "@secondmind/parsers";
import { promises as fs } from "node:fs";
import path from "node:path";
import { temporary } from "./helpers.js";
function pdf(texts: string[]) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${texts.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${texts.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  texts.forEach((text, i) => {
    const stream = `BT /F1 12 Tf 40 700 Td (${text}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    );
  });
  let out = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const start = Buffer.byteLength(out);
  out +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
      .join("") +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(out);
}
function crc32(buffer: Buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(entries: Record<string, string>) {
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const n = Buffer.from(name),
      b = Buffer.from(text),
      header = Buffer.alloc(30),
      dir = Buffer.alloc(46),
      crc = crc32(b);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(b.length, 18);
    header.writeUInt32LE(b.length, 22);
    header.writeUInt16LE(n.length, 26);
    local.push(header, n, b);
    dir.writeUInt32LE(0x02014b50);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(b.length, 20);
    dir.writeUInt32LE(b.length, 24);
    dir.writeUInt16LE(n.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, n);
    offset += header.length + n.length + b.length;
  }
  const index = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(index.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, index, end]);
}
it("extracts PDF text with page provenance", async () => {
  const parsed = await new Parsers().parse(
    pdf(["Annual billing discount", "Parent leave policy"]),
    "sample.pdf",
  );
  expect(parsed.sections).toHaveLength(2);
  expect(parsed.sections[1].location.page).toBe(2);
  expect(parsed.sections[0].text).toContain("Annual billing");
});
it("reports image-only/empty PDFs as requiring OCR", async () => {
  await expect(new Parsers().parse(pdf([""]), "scanned.pdf")).rejects.toThrow(
    "OCR",
  );
});
it("extracts DOCX paragraphs and headings from a bounded archive", async () => {
  const bytes = zip({
    "[Content_Types].xml":
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "_rels/.rels":
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/document.xml":
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Annual billing policy</w:t></w:r></w:p></w:body></w:document>',
  });
  const parsed = await new Parsers().parse(bytes, "sample.docx");
  expect(parsed.sections.map((s) => s.text).join(" ")).toContain(
    "Annual billing policy",
  );
});
it("terminates a stuck parser instead of blocking the service", async () => {
  const root = await temporary(),
    script = path.join(root, "stuck.mjs");
  await fs.writeFile(
    script,
    "import {parentPort} from 'node:worker_threads';parentPort.on('message',()=>{while(true){}})",
  );
  const worker = new ParserWorker(script, 200);
  try {
    await expect(worker.parse(Buffer.from("x"), "a.txt", 100)).rejects.toThrow(
      "time limit",
    );
  } finally {
    await worker.close();
  }
});
