import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const coreRoot = new URL('../../simple-mind-map/', import.meta.url);
const hasCore = existsSync(coreRoot);

// Exercise actual plugin methods with a minimal DOM boundary. SVG rendering and
// browser layout are irrelevant to these readonly and text-escaping regressions.
describe('shared-map label editor regressions', { skip: !hasCore }, () => {
  let utils, htmlEscape;
  before(async () => {
    utils = await readFile(new URL('src/utils/index.js', coreRoot), 'utf8');
    const match = utils.match(/export const htmlEscape = ([\s\S]*?\n\})/);
    assert.ok(match, 'upstream htmlEscape helper exists');
    htmlEscape = runInNewContext('(' + match[1] + ')');
  });
  async function loadPlugin(kind) {
    const source = await readFile(new URL('src/plugins/' + kind + '/' + kind + 'Text.js', coreRoot), 'utf8');
    const moduleBody = source.replace(/^import[\s\S]*?from ['"][^'"]+['"]\r?\n/gm, '').replace('export default {', 'globalThis.plugin = {');
    const context = { htmlEscape, focusInput() {}, selectAllInput() {} };
    runInNewContext(moduleBody, context);
    return context.plugin;
  }
  for (const kind of ['outerFrame', 'associativeLine']) {
    it(kind + ': a readonly viewer cannot open an editable label or trigger editor side effects', async () => {
      const plugin = await loadPlugin(kind);
      const context = { mindMap: { opt: { readonly: true }, emit() { assert.fail('readonly view must not emit editing events'); } } };
      plugin.showEditTextBox.call(context, {});
      assert.equal(Object.hasOwn(context, 'textEditNode'), false);
    });
    it(kind + ': click and double-click do not activate or edit readonly labels', async () => {
      const plugin = await loadPlugin(kind);
      const handlers = {};
      const group = { click(fn) { handlers.click = fn; }, on(name, fn) { handlers[name] = fn; } };
      const context = {
        mindMap: { opt: { readonly: true } },
        draw: { group: () => group }, associativeLineDraw: { group: () => group },
        setActiveOuterFrame() { assert.fail('readonly label must not activate'); },
        setActiveLine() { assert.fail('readonly label must not activate'); },
        showEditTextBox() { assert.fail('readonly label must not edit'); }
      };
      plugin.createText.call(context, { node: {}, toNode: {} }, {}, []);
      const event = { stopPropagation() {} };
      handlers.click(event);
      handlers.dblclick(event);
    });
    it(kind + ': editable imported labels preserve literal markup and newlines without creating elements', async () => {
      const plugin = await loadPlugin(kind);
      const malicious = '<img src=x onerror=alert(1)> & literal\n<script>alert(2)</script>';
      const context = {
        mindMap: { opt: { readonly: false, defaultOuterFrameText: 'Label', defaultAssociativeLineText: 'Label', nodeTextEditZIndex: 1 }, emit() {}, keyCommand: { addShortcut() {} }, view: { scale: 1 } },
        textEditNode: { style: {}, innerHTML: '' },
        activeOuterFrame: { node: {}, range: [] }, activeLine: [{}, {}, {}, {}, {}],
        getText: () => malicious,
        getNodeRangeFirstNode: node => node,
        getStyle: () => ({ textFillPadding: [1, 1, 1, 1], fontFamily: 'sans-serif', fontSize: 14, lineHeight: 1.2 }),
        getStyleConfig: () => ({ associativeLineTextFontFamily: 'sans-serif', associativeLineTextFontSize: 14, associativeLineTextLineHeight: 1.2 }),
        updateTextEditBoxPos() {}, setIsShowTextEdit(value) { this.showTextEdit = value; }
      };
      plugin.showEditTextBox.call(context, {});
      assert.equal(context.showTextEdit, true);
      assert.equal(context.textEditNode.innerHTML, '&lt;img src=x onerror=alert(1)&gt; &amp; literal<br>&lt;script&gt;alert(2)&lt;/script&gt;');
      assert.doesNotMatch(context.textEditNode.innerHTML, /<img|<script/i);
    });
  }
  it('SVG export entity normalization does not decode escaped title markup', () => {
    const match = utils.match(/export const removeHTMLEntities = ([\s\S]*?\n\})/);
    assert.ok(match, 'upstream entity-normalization helper exists');
    const normalize = runInNewContext('(' + match[1] + ')');
    const escaped = '<title>&lt;script&gt;unsafe&lt;/script&gt; &amp; text&nbsp;</title>';
    assert.equal(normalize(escaped), '<title>&lt;script&gt;unsafe&lt;/script&gt; &amp; text&#160;</title>');
  });
});
