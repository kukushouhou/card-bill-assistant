import { describe, expect, it } from 'vitest';
import { flattenHtml } from '../src/parsers/_util';

function previousFlatten(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(tr|p|div|td|table|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ');
}

describe('邮件 HTML 拍平的资源边界', () => {
  it('保留原有标签、脚本、样式、换行与未闭合内容的语义', () => {
    const cases = [
      '<style>.x{color:red}</style><div>账单<br/>金额 123.00</div><script>ignore()</script>',
      '<STYLE>X</StYlE>İ姓名<STYLE>unfinished', '<script>one<script>two</script>end<script>unfinished',
      '<script><style>inner</style>remaining</script>', '<><<<div>one</div><<<',
    ];
    const fragments = ['<', '>', '<>', '<style', '</style>', '<SCRIPT', '</sCrIpT>', '<br />', '</td>', '账单İ', ' \t ', '\n'];
    let state = 1729;
    for (let sample = 0; sample < 300; sample++) {
      let text = '';
      for (let index = 0; index < 24; index++) { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; text += fragments[state % fragments.length]; }
      cases.push(text);
    }
    for (const html of cases) expect(flattenHtml(html)).toBe(previousFlatten(html));
  });

  it('大量未闭合标签不造成重复全文扫描', () => {
    const started = performance.now();
    for (const input of ['<'.repeat(64_000), '<style'.repeat(4_000), '<SCRIPT'.repeat(4_000)]) {
      expect(flattenHtml(input)).toBe(input);
    }
    expect(performance.now() - started).toBeLessThan(300);
  });
});
