/**
 * Host-side rich-document export → DOCX / PDF download.
 * Runs in parent SPA (session origin) so the sandboxed guest need not generate files.
 */

import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  ExternalHyperlink,
  BorderStyle,
} from 'docx';
import { jsPDF } from 'jspdf';
import {
  parseMarkdownBlocks,
  safeExportBasename,
  spansToPlain,
  type InlineSpan,
  type MdBlock,
} from './markdown-blocks.js';

export type ExportFormat = 'docx' | 'pdf';

const HEADING_DOCX: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
  5: HeadingLevel.HEADING_5,
  6: HeadingLevel.HEADING_6,
};

function spansToDocxRuns(spans: InlineSpan[]): (TextRun | ExternalHyperlink)[] {
  const out: (TextRun | ExternalHyperlink)[] = [];
  for (const s of spans) {
    if (s.kind === 'text') {
      out.push(new TextRun({ text: s.text }));
    } else if (s.kind === 'bold') {
      out.push(new TextRun({ text: s.text, bold: true }));
    } else if (s.kind === 'italic') {
      out.push(new TextRun({ text: s.text, italics: true }));
    } else if (s.kind === 'code') {
      out.push(
        new TextRun({
          text: s.text,
          font: 'Courier New',
          size: 18,
        }),
      );
    } else if (s.kind === 'link') {
      out.push(
        new ExternalHyperlink({
          children: [
            new TextRun({
              text: s.text,
              style: 'Hyperlink',
              color: '0563C1',
              underline: {},
            }),
          ],
          link: s.href,
        }),
      );
    }
  }
  return out.length ? out : [new TextRun({ text: '' })];
}

function blockToDocxParagraphs(block: MdBlock): Paragraph[] {
  if (block.type === 'heading') {
    return [
      new Paragraph({
        heading: HEADING_DOCX[block.level] ?? HeadingLevel.HEADING_1,
        children: spansToDocxRuns(block.spans),
      }),
    ];
  }
  if (block.type === 'paragraph') {
    return [new Paragraph({ children: spansToDocxRuns(block.spans), spacing: { after: 120 } })];
  }
  if (block.type === 'bullet') {
    return [
      new Paragraph({
        children: spansToDocxRuns(block.spans),
        bullet: { level: 0 },
      }),
    ];
  }
  if (block.type === 'ordered') {
    return [
      new Paragraph({
        children: [
          new TextRun({ text: `${block.index}. ` }),
          ...spansToDocxRuns(block.spans),
        ],
        spacing: { after: 60 },
      }),
    ];
  }
  if (block.type === 'blockquote') {
    return [
      new Paragraph({
        children: spansToDocxRuns(block.spans),
        indent: { left: 420 },
        border: {
          left: { style: BorderStyle.SINGLE, size: 12, color: 'A8A29E', space: 8 },
        },
        spacing: { after: 120 },
      }),
    ];
  }
  if (block.type === 'code') {
    const lines = block.text.split('\n');
    return lines.map(
      (line, idx) =>
        new Paragraph({
          children: [
            new TextRun({
              text: line || ' ',
              font: 'Courier New',
              size: 18,
            }),
          ],
          shading: { type: 'clear', fill: 'F5F5F4' },
          spacing: { after: idx === lines.length - 1 ? 160 : 0 },
        }),
    );
  }
  if (block.type === 'hr') {
    return [
      new Paragraph({
        border: {
          bottom: { style: BorderStyle.SINGLE, size: 6, color: 'D6D3D1', space: 1 },
        },
        spacing: { before: 120, after: 120 },
      }),
    ];
  }
  return [];
}

async function buildDocxBlob(markdown: string, title: string): Promise<Blob> {
  const blocks = parseMarkdownBlocks(markdown);
  const children: Paragraph[] = [];
  for (const b of blocks) {
    children.push(...blockToDocxParagraphs(b));
  }
  if (children.length === 0) {
    children.push(new Paragraph({ children: [new TextRun({ text: '' })] }));
  }
  const doc = new Document({
    creator: 'Utarus',
    title,
    sections: [{ properties: {}, children }],
  });
  return Packer.toBlob(doc);
}

function buildPdfBlob(markdown: string, title: string): Blob {
  const blocks = parseMarkdownBlocks(markdown);
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 48;
  const maxW = pageW - margin * 2;
  let y = margin;

  const ensureSpace = (need: number) => {
    if (y + need > pageH - margin) {
      doc.addPage();
      y = margin;
    }
  };

  const writeLines = (
    text: string,
    opts: { fontSize: number; fontStyle?: 'normal' | 'bold' | 'italic'; indent?: number },
  ) => {
    const fontStyle = opts.fontStyle ?? 'normal';
    doc.setFont('helvetica', fontStyle);
    doc.setFontSize(opts.fontSize);
    const indent = opts.indent ?? 0;
    const lines = doc.splitTextToSize(text, maxW - indent) as string[];
    for (const line of lines) {
      ensureSpace(opts.fontSize + 6);
      doc.text(line, margin + indent, y);
      y += opts.fontSize + 4;
    }
  };

  // Title header
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(120);
  const header = title.trim() || 'Document';
  ensureSpace(16);
  doc.text(header, margin, y);
  y += 18;
  doc.setTextColor(0);
  doc.setDrawColor(200);
  doc.line(margin, y, pageW - margin, y);
  y += 16;

  for (const b of blocks) {
    if (b.type === 'heading') {
      const sizes = [0, 20, 16, 14, 13, 12, 11];
      writeLines(spansToPlain(b.spans), {
        fontSize: sizes[b.level] ?? 12,
        fontStyle: 'bold',
      });
      y += 4;
    } else if (b.type === 'paragraph') {
      writeLines(spansToPlain(b.spans), { fontSize: 11 });
      y += 6;
    } else if (b.type === 'bullet') {
      writeLines(`• ${spansToPlain(b.spans)}`, { fontSize: 11, indent: 12 });
    } else if (b.type === 'ordered') {
      writeLines(`${b.index}. ${spansToPlain(b.spans)}`, { fontSize: 11, indent: 12 });
    } else if (b.type === 'blockquote') {
      writeLines(spansToPlain(b.spans), { fontSize: 11, fontStyle: 'italic', indent: 16 });
      y += 4;
    } else if (b.type === 'code') {
      doc.setFont('courier', 'normal');
      doc.setFontSize(9);
      const lines = doc.splitTextToSize(b.text || ' ', maxW - 16) as string[];
      for (const line of lines) {
        ensureSpace(12);
        doc.setFillColor(245, 245, 244);
        doc.rect(margin, y - 9, maxW, 12, 'F');
        doc.text(line, margin + 8, y);
        y += 12;
      }
      y += 8;
      doc.setFont('helvetica', 'normal');
    } else if (b.type === 'hr') {
      ensureSpace(12);
      doc.setDrawColor(200);
      doc.line(margin, y, pageW - margin, y);
      y += 14;
    }
  }

  return doc.output('blob');
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after the browser has a chance to start the download
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/**
 * Export markdown to DOCX or PDF and trigger a browser download in the parent window.
 * Fail-fast on invalid input — no silent empty files for bad markdown control chars.
 */
export async function exportRichDocument(opts: {
  format: ExportFormat;
  markdown: string;
  title: string;
}): Promise<{ filename: string }> {
  if (opts.format !== 'docx' && opts.format !== 'pdf') {
    throw new Error(`unsupported export format: ${String(opts.format)}`);
  }
  if (typeof opts.markdown !== 'string') {
    throw new Error('export markdown must be a string');
  }
  if (typeof opts.title !== 'string' || !opts.title.trim()) {
    throw new Error('export title is required');
  }

  const base = safeExportBasename(opts.title);
  if (opts.format === 'docx') {
    const blob = await buildDocxBlob(opts.markdown, opts.title.trim());
    const filename = `${base}.docx`;
    triggerDownload(blob, filename);
    return { filename };
  }

  const blob = buildPdfBlob(opts.markdown, opts.title.trim());
  const filename = `${base}.pdf`;
  triggerDownload(blob, filename);
  return { filename };
}
