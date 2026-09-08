import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Attachment } from 'mailparser';
import * as unpdf from 'unpdf';
vi.mock('../src/lib/prisma', () => ({ prisma: {} }));
vi.mock('unpdf', async (importOriginal) => {
  const actual = await importOriginal<typeof import('unpdf')>();
  return { ...actual, getDocumentProxy: vi.fn(actual.getDocumentProxy) };
});
import { extractPdfText } from '../src/modules/email/email.service';

/** 纯合成的一页 PDF，无外部字体、链接或真实账单数据。 */
function samplePdf(): Buffer {
  const content = 'BT /F1 12 Tf 20 100 Td (Security audit fixture) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let document = '%PDF-1.4\n'; const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(document)); document += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(document);
  document += 'xref\n0 6\n0000000000 65535 f \n';
  for (const offset of offsets) document += String(offset).padStart(10, '0') + ' 00000 n \n';
  document += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(document);
}

afterEach(() => vi.restoreAllMocks());
describe('PDF 附件资源清理', () => {
  it('真实 PDF 完成文字提取和字体修复后释放加载任务', async () => {
    const original = (await vi.importActual<typeof import('unpdf')>('unpdf')).getDocumentProxy;
    const cleanups: Array<{ mock: { calls: unknown[][] } }> = [];
    vi.mocked(unpdf.getDocumentProxy).mockImplementation(async (...args) => {
      const pdf = await original(...args);
      cleanups.push(vi.spyOn(pdf.loadingTask, 'destroy'));
      return pdf;
    });
    const attachment = { filename: 'synthetic.pdf', contentType: 'application/pdf', content: samplePdf() } as Attachment;
    expect(await extractPdfText([attachment])).toContain('Security audit fixture');
    expect(cleanups).toHaveLength(1); expect(cleanups[0]).toHaveBeenCalledOnce();
  });
});
