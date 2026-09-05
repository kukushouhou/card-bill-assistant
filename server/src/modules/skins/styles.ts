import path from 'node:path';
import postcss from 'postcss';
import selectorParser from 'postcss-selector-parser';
import valueParser from 'postcss-value-parser';
import { ApiError } from '../../lib/errors';

export function safePath(value: string): string {
  if (!/^[a-zA-Z0-9_/-]+(?:\.[a-zA-Z0-9_-]+)*$/.test(value) || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(part))) {
    throw new ApiError(400, '皮肤包包含无效文件路径');
  }
  return value;
}

export function assetReference(value: string, from: string, files: Map<string, Buffer>): string {
  if (!value || /[\\:%?#]/.test(value) || value.startsWith('/')) throw new ApiError(400, '皮肤资源必须来自包内');
  const resolved = safePath(path.posix.normalize(path.posix.join(path.posix.dirname(from), value)));
  if (!files.has(resolved) || !/\.(png|jpg|jpeg|webp|gif|avif|svg|woff2?|ttf|otf)$/i.test(resolved)) throw new ApiError(400, '皮肤资源不存在或格式不支持：' + resolved);
  return resolved;
}

/** 将皮肤限定在其视觉作用域，所有资源引用在校验时归一化。 */
export function compileStyle(css: string, filename: string, files: Map<string, Buffer>, scope: string, baseUrl: string): string {
  if (css.length > 2 * 1024 * 1024 || /[\\<]/.test(css)) throw new ApiError(400, '皮肤样式包含不支持的内容');
  let root;
  try { root = postcss.parse(css, { from: filename }); } catch { throw new ApiError(400, '皮肤样式无法解析：' + filename); }
  root.walkAtRules(rule => {
    if (!['media', 'supports', 'font-face', 'keyframes', '-webkit-keyframes', 'layer'].includes(rule.name.toLowerCase())) throw new ApiError(400, '皮肤不支持此样式规则：' + rule.name);
    if (/url\s*\(|https?:|\/\//i.test(rule.params)) throw new ApiError(400, '皮肤样式不能引用外部资源');
  });
  root.walkRules(rule => {
    if (rule.parent?.type === 'atrule' && /keyframes$/i.test(rule.parent.name)) return;
    try {
      const ast = selectorParser().astSync(rule.selector);
      ast.walk(node => {
        if (node.type === 'id' || (node.type === 'attribute' && !['data-skin-slot', 'data-skin-icon', 'data-skin-decoration'].includes(node.attribute)) || (node.type === 'pseudo' && /:has|:visited/i.test(node.value))) throw new Error();
      });
      rule.selectors = rule.selectors.map(selector => {
        const trimmed = selector.trim();
        if (/^(:root|html|body)(?=$|[\s.:[])/.test(trimmed)) return trimmed.replace(/^(:root|html|body)/, scope);
        return scope + ' ' + trimmed;
      });
    } catch { throw new ApiError(400, '皮肤包含不支持的选择器：' + rule.selector); }
  });
  root.walkDecls(decl => {
    const property = decl.prop.toLowerCase();
    const decorative = decl.parent?.type === 'rule' && decl.parent.selector.includes('data-skin-decoration');
    if (['behavior', '-moz-binding'].includes(property) || /expression\s*\(|javascript:|image-set\s*\(/i.test(decl.value)) throw new ApiError(400, '皮肤样式包含不支持的内容');
    if (!decorative && ((property === 'display' && /none/i.test(decl.value)) || (property === 'visibility' && /hidden|collapse/i.test(decl.value)) || (property === 'opacity' && Number(decl.value) < 0.4) || property === 'content' || property === 'pointer-events' || /clip-path|^clip$/.test(property))) throw new ApiError(400, '皮肤不能隐藏或替换界面内容');
    const value = valueParser(decl.value);
    value.walk(node => {
      if (node.type !== 'function' || node.value.toLowerCase() !== 'url') return;
      const raw = valueParser.stringify(node.nodes).trim().replace(/^['"]|['"]$/g, '');
      if (/^#[a-zA-Z][\w-]*$/.test(raw)) return;
      const resolved = assetReference(raw, filename, files);
      node.nodes = [{ type: 'string', quote: '"', value: baseUrl + resolved, sourceIndex: 0, sourceEndIndex: 0 }];
    });
    decl.value = value.toString();
  });
  return root.toString();
}
