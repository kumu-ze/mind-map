import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import sanitizeHtml from 'sanitize-html';
const scrypt = promisify(scryptCb);
export const token = () => randomBytes(32).toString('base64url');
export const digest = value => createHash('sha256').update(value).digest('hex');
export class HttpError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } }
export const fail = (status, message, code) => { throw new HttpError(status, message, code); };
export async function hashPassword(password) {
 if (typeof password !== 'string' || password.length < 12 || password.length > 128) fail(400, '密码需为 12–128 个字符');
 const salt = randomBytes(16).toString('hex');
 return salt + ':' + (await scrypt(password, salt, 64)).toString('hex');
}
export async function verifyPassword(password, stored) {
 if (typeof password !== 'string' || password.length > 128) return false;
 const [salt, hash] = stored.split(':');
 const actual = await scrypt(password, salt, 64);
 return timingSafeEqual(actual, Buffer.from(hash, 'hex'));
}
export function title(value, fallback = '') {
 const result = typeof value === 'string' ? value.trim() : fallback;
 if (!result || result.length > 120) fail(400, '名称需为 1–120 个字符');
 return result;
}
const safeUrl = value => /^(https?:\/\/|mailto:)/i.test(value) || /^data:image\/(png|jpeg|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(value);
const htmlOptions = {
 allowedTags: ['p','br','span','strong','b','em','i','u','s','strike','sub','sup','code','pre','blockquote','ul','ol','li','a'],
 allowedAttributes: { '*': ['style','class'], a: ['href','title','target','rel'] },
 allowedSchemes: ['http','https','mailto'],
 allowedStyles: { '*': {
  color: [/^#[0-9a-f]{3,8}$/i, /^rgba?\([\d.,%\s]+\)$/i, /^[a-z]+$/i],
  'background-color': [/^#[0-9a-f]{3,8}$/i, /^rgba?\([\d.,%\s]+\)$/i, /^[a-z]+$/i],
  'font-size': [/^\d+(\.\d+)?(px|em|rem|%)$/],
  'font-weight': [/^(normal|bold|[1-9]00)$/], 'font-style': [/^(normal|italic)$/],
  'text-decoration': [/^(none|underline|line-through)$/], 'text-align': [/^(left|right|center)$/]
 }}
};
// Keep the upstream document format, while rejecting executable URLs and sanitizing rich text.
export function cleanMap(input) {
 if (!input || typeof input !== 'object' || Array.isArray(input) || !input.root?.data) fail(400, '导图格式无效');
 let fields = 0, nodes = 0;
 function checkNode(node, depth = 0) {
  if(depth > 70 || !node || typeof node !== 'object' || Array.isArray(node) ||
     !node.data || typeof node.data !== 'object' || Array.isArray(node.data) ||
     typeof node.data.text !== 'string' ||
     (node.children !== undefined && !Array.isArray(node.children))) fail(400, '节点结构无效或层级过深');
  if(++nodes > 5000) fail(400, '单张导图最多 5000 个节点');
  for(const child of node.children || []) checkNode(child,depth+1);
 }
 checkNode(input.root);
 nodes = 0;
 function walk(value, depth = 0, key = '', parent = null) {
  if (depth > 160 || ++fields > 160000) fail(400, '导图过大或层级过深');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail(400, '导图数据无效'); return value; }
  if (typeof value === 'string') {
   if (value.length > 8 * 1024 * 1024) fail(413, '单个资源过大');
   if ((key === 'text' && parent?.richText === true) || key === 'note') return sanitizeHtml(value, htmlOptions);
   if (/^(hyperlink|attachmentUrl|url|href|backgroundImage)$/i.test(key)) return (!value || safeUrl(value)) ? value : '';
   if (key === 'image' && /[:<]/.test(value) && !safeUrl(value)) return '';
   if (/^\s*(javascript:|vbscript:|data:text\/html|data:image\/svg\+xml)/i.test(value)) return '';
   return value;
  }
  if (Array.isArray(value)) return value.map(item => walk(item, depth + 1));
  if (typeof value !== 'object') fail(400, '导图数据无效');
  if (value.data?.text !== undefined && ++nodes > 5000) fail(400, '单张导图最多 5000 个节点');
  const result = {};
  for (const [k,v] of Object.entries(value)) {
   if (['__proto__','prototype','constructor'].includes(k)) continue;
   if (k === 'richText' && typeof v !== 'boolean') fail(400, '富文本标志必须为布尔值');
   result[k] = walk(v, depth + 1, k, value);
  }
  return result;
 }
 return walk(input);
}
export const emptyMap = () => ({ root: { data: { text: '中心主题', expand: true }, children: [] }, layout: 'logicalStructure', theme: { template: 'default', config: {} } });
