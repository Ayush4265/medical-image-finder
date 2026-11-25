const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

class Element {
  constructor(tag = 'div', options = {}) {
    this.tag = tag;
    this.options = options;
    this.children = [];
    this.listeners = {};
    this.value = options.attr?.value || '';
    this.text = options.text || '';
    this.style = {};
  }
  empty() { this.children = []; }
  addClass() {}
  createEl(tag, options) { const el = new Element(tag, options); this.children.push(el); return el; }
  createDiv(options) { return this.createEl('div', options); }
  createSpan(options) { return this.createEl('span', options); }
  addEventListener(event, callback) { this.listeners[event] = callback; }
  setText(text) { this.text = text; }
  focus() {}
  all() { return [this, ...this.children.flatMap(child => child.all())]; }
}

function harness(request = async () => { throw Error('Unexpected request'); }, extra = {}) {
  const notices = [];
  let clipboardText = '';
  class TFile { constructor(name) { this.path = name; this.basename = name.replace(/\.md$/, ''); this.extension = name.endsWith('.md') ? 'md' : 'png'; } }
  class MarkdownView {}
  class ItemView { constructor(leaf) { this.leaf = leaf; this.contentEl = new Element(); } }
  const electron = {
    nativeImage: { createFromBuffer: bytes => ({ isEmpty: () => !bytes.length || bytes[0] === 60, toPNG: () => Buffer.from([137,80,78,71,13,10,26,10,1]) }) },
    clipboard: {
      writeText: (t) => { clipboardText = t; },
      readText: () => clipboardText,
      writeImage() {}
    },
    shell: { openExternal() {} }
  };
  const obsidian = {
    Plugin: class {},
    ItemView,
    TFile,
    MarkdownView,
    Modal: class { constructor() { this.contentEl = new Element(); this.titleEl = new Element(); } open() { if (this.onOpen) this.onOpen(); } close() { if (this.onClose) this.onClose(); } },
    Notice: class { constructor(text) { notices.push(text); } },
    PluginSettingTab: class {},
    normalizePath: p => p,
    requestUrl: request
  };
  const windowListeners = {};
  const mockWindow = {
    addEventListener: (event, cb) => { windowListeners[event] = cb; },
    removeEventListener: (event, cb) => { delete windowListeners[event]; },
    setInterval,
    clearInterval
  };
  const context = { require: id => id === 'obsidian' ? obsidian : id === 'electron' ? electron : require(id), module: {exports:{}}, Buffer, URL, Blob, setTimeout, clearTimeout, setInterval, clearInterval, window: mockWindow, console, ...extra };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8') + '\nmodule.exports._test = { MedicalImageFinderView, GeminiScannerService, GeminiResponseImportModal, DuckDuckGoProvider, WikimediaProvider, GoogleCseProvider, SerpApiProvider, BraveProvider, normalizeSettings, normalizeResults, attachmentPath, imageExtension, safeError };', context);
  const Plugin = context.module.exports;
  const plugin = new Plugin();
  plugin.settings = Plugin._test.normalizeSettings({});
  plugin.pendingActions = new Map();
  plugin.writeQueue = Promise.resolve();
  const files = new Map();
  const leaves = [];
  const workspace = { active: null, getActiveViewOfType() { return this.active; }, getLeavesOfType(type) { return leaves.filter(l => type === 'markdown' ? l.view instanceof MarkdownView : !(l.view instanceof MarkdownView)); }, revealLeaf: async () => {} };
  const vault = { getAbstractFileByPath: p => files.get(p), createFolder: async p => { files.set(p, {}); }, createBinary: async (p, bytes) => { const file = new TFile(p); file.bytes = Buffer.from(bytes); files.set(p,file); }, readBinary: async f => f.bytes };
  plugin.app = {workspace, vault};

  function note(name, text = 'First line\nSecond line\nThird line') {
    const file = new TFile(name);
    files.set(name, file);
    const view = new MarkdownView();
    view.file = file;
    view.editor = {
      text,
      cursor: 0,
      inserts: [],
      getValue() { return this.text; },
      getCursor() { return {line:this.cursor, ch:0}; },
      getLine(line) { return this.text.split('\n')[line] || ''; },
      lineCount() { return this.text.split('\n').length; },
      getSelection() { return 'selected'; },
      setCursor(pos) { this.cursor = pos.line; },
      scrollIntoView() {},
      replaceRange(t, pos) { this.inserts.push({text: t, pos}); this.text += t; }
    };
    view.leaf = { view };
    leaves.push(view.leaf);
    workspace.active = view;
    plugin.lastMarkdownView = view;
    return view;
  }

  function sidebar(render = true) {
    const view = new Plugin._test.MedicalImageFinderView({}, plugin);
    view.app = plugin.app;
    leaves.push({view});
    if (render) view.render();
    return view;
  }

  return {
    Plugin,
    ...Plugin._test,
    plugin,
    workspace,
    vault,
    files,
    leaves,
    note,
    sidebar,
    notices,
    electron,
    window: mockWindow,
    windowListeners,
    getClipboard: () => clipboardText,
    setClipboard: (t) => { clipboardText = t; }
  };
}

test('buildAltGPrompt prefixes all lines with [L<number>] and includes medical prompt', () => {
  const h = harness();
  const prompt = h.GeminiScannerService.buildAltGPrompt('Appendicitis Note', 'Surgical anatomy\nMcBurney point\nIncision layers');
  assert.match(prompt, /\[L1\] Surgical anatomy/);
  assert.match(prompt, /\[L2\] McBurney point/);
  assert.match(prompt, /\[L3\] Incision layers/);
  assert.match(prompt, /MBBS medical educator/);
  assert.match(prompt, /ANATOMY\/DIAGRAM/);
  assert.match(prompt, /DuckDuckGo/);
});

test('parseGeminiResponse parses pure JSON and markdown fences', () => {
  const h = harness();
  const jsonInput = '```json\n{"summary": "Test summary", "suggestions": [{"heading": "Anatomy", "line": 2, "visualConcept": "Triangle of Calot", "visualType": "diagram", "rationale": "High-yield boundary", "recommendedQuery": "triangle of calot boundaries anatomy"}]}\n```';
  const result = h.GeminiScannerService.parseGeminiResponse(jsonInput, 10);
  assert.equal(result.suggestions.length, 1);
  assert.equal(result.suggestions[0].heading, 'Anatomy');
  assert.equal(result.suggestions[0].line, 2);
  assert.equal(result.suggestions[0].visualConcept, 'Triangle of Calot');
  assert.equal(result.suggestions[0].visualType, 'diagram');
  assert.equal(result.suggestions[0].recommendedQuery, 'triangle of calot boundaries anatomy');
});

test('parseGeminiResponse parses standard Markdown numbered lists', () => {
  const h = harness();
  const mdInput = `
Here are the visual opportunities for your note:

1. **Heading**: Surgical Triangles
   - **Line**: [L15]
   - **Concept**: Hesselbach Triangle
   - **Type**: Anatomy Diagram
   - **Rationale**: Direct vs indirect hernia landmark for viva.
   - **DuckDuckGo Search Query**: \`hesselbach triangle anatomy boundaries diagram\`

2. **Heading**: Pathognomonic Radiology
   - **Line**: Line 32
   - **Concept**: Coffee Bean Sign
   - **Type**: Radiology
   - **Rationale**: Sigmoid volvulus abdominal X-ray hallmark.
   - **Query**: sigmoid volvulus coffee bean sign x-ray
`;
  const result = h.GeminiScannerService.parseGeminiResponse(mdInput, 50);
  assert.equal(result.suggestions.length, 2);
  assert.equal(result.suggestions[0].line, 15);
  assert.equal(result.suggestions[0].visualConcept, 'Hesselbach Triangle');
  assert.equal(result.suggestions[0].visualType, 'diagram');
  assert.equal(result.suggestions[0].recommendedQuery, 'hesselbach triangle anatomy boundaries diagram');

  assert.equal(result.suggestions[1].line, 32);
  assert.equal(result.suggestions[1].visualConcept, 'Coffee Bean Sign');
  assert.equal(result.suggestions[1].visualType, 'radiology');
  assert.equal(result.suggestions[1].recommendedQuery, 'sigmoid volvulus coffee bean sign x-ray');
});

test('parseGeminiResponse parses bulleted Markdown lists with bold headers', () => {
  const h = harness();
  const mdBulletInput = `
* **Gastric Mucosa Histology**
  - Line: 12
  - Concept: Parietal and Chief cells
  - Type: Histology
  - Rationale: High-yield microscopic distinction.
  - Query: gastric gland histology parietal chief cells

* **Lauren Classification**
  - Line: 48
  - Concept: Intestinal vs Diffuse type gastric cancer
  - Type: Criteria
  - Rationale: Staging and prognostic scoring.
  - Query: lauren classification gastric carcinoma table
`;
  const result = h.GeminiScannerService.parseGeminiResponse(mdBulletInput, 100);
  assert.equal(result.suggestions.length, 2);
  assert.equal(result.suggestions[0].line, 12);
  assert.equal(result.suggestions[0].visualType, 'histology');
  assert.equal(result.suggestions[1].line, 48);
  assert.equal(result.suggestions[1].visualType, 'criteria');
});

test('parseGeminiResponse recovers from truncated JSON', () => {
  const h = harness();
  const truncated = `{"summary": "Cut off mid array", "suggestions": [{"heading": "Surgery", "line": 4, "visualConcept": "Bassini Repair", "visualType": "clinical", "rationale": "Hernia repair layers", "recommendedQuery": "bassini hernia repair steps diagram"}`;
  const result = h.GeminiScannerService.parseGeminiResponse(truncated, 20);
  assert.equal(result.suggestions.length, 1);
  assert.equal(result.suggestions[0].visualConcept, 'Bassini Repair');
});

test('copyNotePromptForAltG copies full prompt to clipboard and prompts user', async () => {
  const h = harness();
  const note = h.note('Hernia.md', 'Line 1\nLine 2\nLine 3');
  const view = h.sidebar(true);
  view.switchToScanTab();

  await view.copyNotePromptForAltG();
  const clip = h.getClipboard();
  assert.ok(clip.includes('[L1] Line 1'));
  assert.ok(clip.includes('[L2] Line 2'));
  assert.ok(clip.includes('MBBS medical educator'));
  assert.equal(view.waitingForGemini, true);
  assert.ok(h.notices.some(n => n.includes('Press Alt+G')));
});

test('importGeminiResponseFromClipboard imports clipboard text and renders visual cards', async () => {
  const h = harness();
  const note = h.note('Hernia.md', 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5');
  const view = h.sidebar(true);
  await view.copyNotePromptForAltG();

  const geminiResponse = JSON.stringify({
    summary: 'Hernia repair audit',
    suggestions: [
      { heading: 'Anatomy', line: 2, visualConcept: 'Deep Inguinal Ring', visualType: 'diagram', rationale: 'Key defect landmark', recommendedQuery: 'deep inguinal ring anatomy' }
    ]
  });
  h.setClipboard(geminiResponse);

  await view.importGeminiResponseFromClipboard();
  assert.equal(view.scanResults.suggestions.length, 1);
  assert.equal(view.waitingForGemini, false);
  assert.ok(h.notices.some(n => n.includes('Imported 1 visual suggestions')));
});

test('quick find displays multiple DuckDuckGo options and insert targets exact line', async () => {
  const h = harness();
  const note = h.note('Hernia.md', 'First\nSecond\nThird');
  const view = h.sidebar(true);
  await view.copyNotePromptForAltG();

  const item1 = { title: 'Option 1', imageUrl: 'https://example.org/1.png', domain: 'example.org' };
  const item2 = { title: 'Option 2', imageUrl: 'https://example.org/2.png', domain: 'example.org' };
  const item3 = { title: 'Option 3', imageUrl: 'https://example.org/3.png', domain: 'example.org' };
  const item4 = { title: 'Option 4', imageUrl: 'https://example.org/4.png', domain: 'example.org' };

  h.plugin.getActiveProvider = () => ({
    name: 'DuckDuckGo',
    search: async () => [item1, item2, item3, item4]
  });
  h.plugin.downloadImage = async () => ({ bytes: Buffer.from([137,80,78,71,13,10,26,10,1]), ext: 'png' });

  view.scanResults = {
    summary: 'Test audit',
    suggestions: [
      { heading: 'Anatomy', line: 2, visualConcept: 'Inguinal Ring', visualType: 'diagram', rationale: 'Viva', recommendedQuery: 'inguinal ring' }
    ]
  };

  await view.executeInlineQuickFind(0, 'inguinal ring', 'diagram');
  const quickList = view.inlineQuickResults.get(0);
  assert.equal(quickList.length, 4);
  assert.equal(quickList[0].targetLine, 2);
  assert.equal(quickList[0].targetContext.file, note.file);

  // Perform 1-click insert of option 2
  await h.plugin.saveAndInsertImage(quickList[1]);
  assert.equal(note.editor.inserts.length, 1);
  assert.equal(note.editor.inserts[0].pos.line, 1); // 0-indexed line 1 corresponds to line 2
});

test('Search images button preloads query and targets exact line on insert', async () => {
  const h = harness();
  const note = h.note('Hernia.md', 'Header\nBody line 2\nBody line 3');
  const view = h.sidebar(true);
  await view.copyNotePromptForAltG();

  const item = { title: 'Search Result', imageUrl: 'https://example.org/img.png', domain: 'example.org' };
  h.plugin.getActiveProvider = () => ({
    name: 'DuckDuckGo',
    search: async () => [item]
  });
  h.plugin.downloadImage = async () => ({ bytes: Buffer.from([137,80,78,71,13,10,26,10,1]), ext: 'png' });

  view.searchTargetContext = view.scanContext;
  view.searchTargetLine = 3;
  view.switchToSearchTab('hesselbach triangle', 'diagram', true);
  await view.executeSearch('hesselbach triangle');

  assert.equal(view.results.length, 1);
  assert.equal(view.results[0].targetLine, 3);
  assert.equal(view.results[0].targetContext.file, note.file);

  await h.plugin.saveAndInsertImage(view.results[0]);
  assert.equal(note.editor.inserts.length, 1);
  assert.equal(note.editor.inserts[0].pos.line, 2); // line 3 -> index 2
});

test('parseGeminiResponse parses Markdown tables', () => {
  const h = harness();
  const tableInput = `
Here are the visual opportunities in table format:

| Line | Heading | Visual Concept | Type | Clinical Rationale | Search Query |
|---|---|---|---|---|---|
| [L12] | Achalasia | Bird's beak sign | Radiology | Pathognomonic barium swallow sign showing smooth tapering of lower esophagus | achalasia cardia barium swallow bird beak sign |
| 45 | Barrett Esophagus | Salmon-pink mucosa | Histology | Intestinal metaplasia with goblet cells | barrett esophagus intestinal metaplasia goblet cells histology |
`;

  const result = h.GeminiScannerService.parseGeminiResponse(tableInput, 100);
  assert.equal(result.suggestions.length, 2);
  assert.equal(result.suggestions[0].line, 12);
  assert.equal(result.suggestions[0].heading, 'Achalasia');
  assert.equal(result.suggestions[0].visualConcept, "Bird's beak sign");
  assert.equal(result.suggestions[0].visualType, 'radiology');
  assert.equal(result.suggestions[0].recommendedQuery, 'achalasia cardia barium swallow bird beak sign');

  assert.equal(result.suggestions[1].line, 45);
  assert.equal(result.suggestions[1].heading, 'Barrett Esophagus');
  assert.equal(result.suggestions[1].visualConcept, 'Salmon-pink mucosa');
  assert.equal(result.suggestions[1].visualType, 'histology');
});

test('parseGeminiResponse parses numbered headings with sub-bullets without duplicating', () => {
  const h = harness();
  const input = `
### 1. Inguinal Canal Anatomy
- **Line**: Line 14
- **Heading**: Anatomy of Inguinal Canal
- **Visual Concept**: Boundaries of Inguinal Canal
- **Visual Type**: Diagram
- **Clinical Rationale**: High-yield viva question.
- **Search Query**: "inguinal canal boundaries anterior posterior wall diagram"

### 2. Direct vs Indirect Hernia
- **Line**: [L35]
- **Heading**: Hernia Types
- **Concept**: Hesselbach's Triangle
- **Type**: diagram
- **Rationale**: Distinction for clinical exam.
- **DuckDuckGo Query**: "hesselbach triangle inferior epigastric artery hernia anatomy"
`;

  const result = h.GeminiScannerService.parseGeminiResponse(input, 100);
  assert.equal(result.suggestions.length, 2, 'Should parse exactly 2 suggestions rather than splitting each field into items');
  assert.equal(result.suggestions[0].line, 14);
  assert.equal(result.suggestions[0].heading, 'Anatomy of Inguinal Canal');
  assert.equal(result.suggestions[0].visualConcept, 'Boundaries of Inguinal Canal');
  assert.equal(result.suggestions[0].visualType, 'diagram');
  assert.equal(result.suggestions[0].recommendedQuery, 'inguinal canal boundaries anterior posterior wall diagram');

  assert.equal(result.suggestions[1].line, 35);
  assert.equal(result.suggestions[1].heading, 'Hernia Types');
  assert.equal(result.suggestions[1].visualConcept, "Hesselbach's Triangle");
});

test('parseGeminiResponse parses top-level JSON array and cleans trailing commas', () => {
  const h = harness();
  const arrayInput = `
\`\`\`json
[
  {
    "heading": "Liver Anatomy",
    "line": 12,
    "visualConcept": "Couinaud liver segments",
    "visualType": "diagram",
    "rationale": "Key anatomical classification for hepatectomy",
    "recommendedQuery": "couinaud liver segments functional anatomy",
  },
]
\`\`\`
`;
  const result = h.GeminiScannerService.parseGeminiResponse(arrayInput, 100);
  assert.equal(result.suggestions.length, 1);
  assert.equal(result.suggestions[0].line, 12);
  assert.equal(result.suggestions[0].visualConcept, 'Couinaud liver segments');
});

test('consecutive insertions from scanner view update scanContext and allow multiple image insertions', async () => {
  const h = harness();
  const note = h.note('Hernia.md', 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5');
  const view = h.sidebar(true);
  await view.copyNotePromptForAltG();

  const item1 = { title: 'Option 1', imageUrl: 'https://example.org/1.png', domain: 'example.org' };
  const item2 = { title: 'Option 2', imageUrl: 'https://example.org/2.png', domain: 'example.org' };

  h.plugin.getActiveProvider = () => ({
    name: 'DuckDuckGo',
    search: async () => [item1, item2]
  });
  h.plugin.downloadImage = async () => ({ bytes: Buffer.from([137,80,78,71,13,10,26,10,1]), ext: 'png' });

  view.scanResults = {
    summary: 'Multi-item audit',
    suggestions: [
      { heading: 'Anatomy 1', line: 1, visualConcept: 'Ring 1', visualType: 'diagram', recommendedQuery: 'ring 1' },
      { heading: 'Anatomy 2', line: 3, visualConcept: 'Ring 2', visualType: 'diagram', recommendedQuery: 'ring 2' }
    ]
  };

  await view.executeInlineQuickFind(0, 'ring 1', 'diagram');
  await view.executeInlineQuickFind(1, 'ring 2', 'diagram');

  const list0 = view.inlineQuickResults.get(0);
  const list1 = view.inlineQuickResults.get(1);

  // First insertion from option 0
  await h.plugin.saveAndInsertImage(list0[0]);
  if (view.scanContext && view.scanContext.file === list0[0].targetContext?.file) {
    view.scanContext.content = view.scanContext.editor.getValue();
  }
  assert.equal(note.editor.inserts.length, 1);

  // Second insertion from option 1 (must succeed without "target note was changed or closed")
  await h.plugin.saveAndInsertImage(list1[0]);
  if (view.scanContext && view.scanContext.file === list1[0].targetContext?.file) {
    view.scanContext.content = view.scanContext.editor.getValue();
  }
  assert.equal(note.editor.inserts.length, 2);

  // Jumping to line after consecutive insertions must also succeed
  await view.jumpToLine(3);
  assert.ok(h.notices.some(n => n.includes('Navigated to line 3')));
});

test('clipboard watcher auto-detects response on window focus and renders visual cards', async () => {
  const h = harness();
  const note = h.note('Hernia.md', 'First\nSecond\nThird');
  const view = h.sidebar(true);
  view.switchToScanTab();

  await view.copyNotePromptForAltG();
  assert.equal(view.waitingForGemini, true);
  assert.equal(view.isWatchingClipboard, true);

  // User copies Gemini response to clipboard while outside
  const geminiResponse = JSON.stringify({
    summary: 'Auto-detected response',
    suggestions: [
      { heading: 'Anatomy', line: 2, visualConcept: 'Deep Ring', visualType: 'diagram', rationale: 'Key defect', recommendedQuery: 'deep inguinal ring anatomy' }
    ]
  });
  h.setClipboard(geminiResponse);

  // User returns to Obsidian (window focus event)
  await view.checkClipboardForResponse();

  assert.equal(view.waitingForGemini, false);
  assert.equal(view.isWatchingClipboard, false);
  assert.equal(view.scanResults.suggestions.length, 1);
  assert.ok(h.notices.some(n => n.includes('Auto-detected Gemini response')));
});

test('canceling waiting for Gemini stops watcher and resets banner', async () => {
  const h = harness();
  const note = h.note('Hernia.md', 'Line 1\nLine 2');
  const view = h.sidebar(true);
  view.switchToScanTab();

  await view.copyNotePromptForAltG();
  assert.equal(view.waitingForGemini, true);

  // Find cancel button in Step 2 box
  const cancelBtn = view.contentEl.all().find(e => e.tag === 'button' && e.text === 'Cancel');
  assert.ok(cancelBtn, 'Cancel button should be present in Step 2 guidance box');
  cancelBtn.onclick();

  assert.equal(view.waitingForGemini, false);
  assert.equal(view.isWatchingClipboard, false);
});

test('parseGeminiResponse strictly sorts suggestions in ascending line order (a.line - b.line)', () => {
  const h = harness();
  const scrambledLines = [1678, 34, 60, 52, 107, 123, 1604, 207, 293, 1872];
  const suggestions = scrambledLines.map((line, idx) => ({
    heading: `Section ${idx}`,
    line,
    visualConcept: `Concept at line ${line}`,
    visualType: 'diagram',
    rationale: 'High-yield exam review',
    recommendedQuery: `anatomy diagram line ${line}`
  }));

  const input = JSON.stringify({ summary: 'Scrambled lines note', suggestions });
  const result = h.GeminiScannerService.parseGeminiResponse(input, 2000);

  assert.equal(result.suggestions.length, 10);
  const resultLines = result.suggestions.map(s => s.line);
  const expectedLines = [...scrambledLines].sort((a, b) => a - b);
  assert.equal(JSON.stringify(resultLines), JSON.stringify(expectedLines), 'Output suggestions must be strictly sorted by ascending line order');
});

test('parseGeminiResponse caps at 25 suggestions and selects highest-yield NEET-PG concepts first, sorted by ascending line', () => {
  const h = harness();
  // Create 32 suggestions: 25 high-yield (triangles, pathognomonic signs, criteria tables, hallmarks, curves) + 7 low-yield filler
  const highYieldItems = [
    { heading: 'Anatomy', line: 10, visualConcept: 'Triangle of Calot', visualType: 'diagram', rationale: 'Cystic artery and duct boundaries for cholecystectomy', recommendedQuery: 'triangle of calot boundaries' },
    { heading: 'Radiology', line: 20, visualConcept: 'Double bubble sign', visualType: 'radiology', rationale: 'Pathognomonic duodenal atresia neonatal X-ray', recommendedQuery: 'double bubble sign x-ray' },
    { heading: 'Anatomy', line: 30, visualConcept: 'Passaro triangle', visualType: 'diagram', rationale: 'Gastrinoma triangle boundaries for viva', recommendedQuery: 'passaro triangle diagram' },
    { heading: 'Clinical', line: 40, visualConcept: 'Grey Turner Cullen sign', visualType: 'clinical', rationale: 'Classic acute hemorrhagic pancreatitis signs', recommendedQuery: 'grey turner cullen sign' },
    { heading: 'Surgery', line: 50, visualConcept: 'Whipple procedure reconstruction', visualType: 'clinical', rationale: 'Pancreaticoduodenectomy anastomoses diagram', recommendedQuery: 'whipple procedure labeled diagram' },
    { heading: 'Radiology', line: 60, visualConcept: 'Bird-beak sign', visualType: 'radiology', rationale: 'Pathognomonic barium swallow in achalasia cardia', recommendedQuery: 'bird beak sign barium' },
    { heading: 'Radiology', line: 70, visualConcept: 'Coffee-bean sign', visualType: 'radiology', rationale: 'Pathognomonic sigmoid volvulus abdominal radiograph', recommendedQuery: 'coffee bean sign x-ray' },
    { heading: 'Radiology', line: 80, visualConcept: 'Whirl sign', visualType: 'radiology', rationale: 'Pathognomonic mesenteric volvulus on CT scan', recommendedQuery: 'whirl sign ct' },
    { heading: 'Radiology', line: 90, visualConcept: 'Apple-core sign', visualType: 'radiology', rationale: 'Classic colon carcinoma on barium enema', recommendedQuery: 'apple core lesion barium' },
    { heading: 'Radiology', line: 100, visualConcept: 'Target sign', visualType: 'radiology', rationale: 'Pathognomonic intussusception on ultrasound USG', recommendedQuery: 'intussusception target sign usg' },
    { heading: 'Pathology', line: 110, visualConcept: 'Reed-Sternberg cells', visualType: 'histology', rationale: 'Microscopic hallmark of Hodgkin lymphoma', recommendedQuery: 'reed sternberg cells histology' },
    { heading: 'Pathology', line: 120, visualConcept: 'Psammoma bodies', visualType: 'histology', rationale: 'Hallmark of papillary thyroid and meningioma', recommendedQuery: 'psammoma bodies pathology' },
    { heading: 'Pathology', line: 130, visualConcept: 'Orphan Annie eyes', visualType: 'histology', rationale: 'Ground glass nuclei in papillary carcinoma thyroid', recommendedQuery: 'orphan annie nuclei histology' },
    { heading: 'Pathology', line: 140, visualConcept: 'Signet-ring cells', visualType: 'histology', rationale: 'Hallmark of diffuse gastric adenocarcinoma', recommendedQuery: 'signet ring cells histology' },
    { heading: 'Criteria', line: 150, visualConcept: 'Child-Pugh score table', visualType: 'criteria', rationale: 'Cirrhosis mortality grading and surgical risk table', recommendedQuery: 'child pugh score table' },
    { heading: 'Criteria', line: 160, visualConcept: 'Alvarado score table', visualType: 'criteria', rationale: 'Acute appendicitis diagnosis criteria scoring', recommendedQuery: 'alvarado score table' },
    { heading: 'Criteria', line: 170, visualConcept: 'Ranson criteria table', visualType: 'criteria', rationale: 'Acute pancreatitis prognosis criteria at admission', recommendedQuery: 'ranson criteria table' },
    { heading: 'Criteria', line: 180, visualConcept: 'Forrest classification', visualType: 'criteria', rationale: 'Peptic ulcer bleeding endoscopic staging table', recommendedQuery: 'forrest classification table' },
    { heading: 'Criteria', line: 190, visualConcept: 'Lauren classification', visualType: 'criteria', rationale: 'Intestinal vs diffuse gastric cancer staging table', recommendedQuery: 'lauren classification table' },
    { heading: 'Physiology', line: 200, visualConcept: 'Frank-Starling curve', visualType: 'embryology', rationale: 'Ventricular stroke volume vs preload graph', recommendedQuery: 'frank starling curve physiology' },
    { heading: 'Physiology', line: 210, visualConcept: 'Oxygen-hemoglobin dissociation curve', visualType: 'embryology', rationale: 'Bohr effect right and left shifts curve graph', recommendedQuery: 'oxygen hemoglobin dissociation curve' },
    { heading: 'Physiology', line: 220, visualConcept: 'Cardiac action potential curve', visualType: 'embryology', rationale: 'Ventricular phase 0-4 ion channel curve graph', recommendedQuery: 'cardiac action potential phases' },
    { heading: 'Anatomy', line: 230, visualConcept: 'Hesselbach triangle boundaries', visualType: 'diagram', rationale: 'Direct inguinal hernia surgical anatomy boundaries', recommendedQuery: 'hesselbach triangle anatomy boundaries' },
    { heading: 'Anatomy', line: 240, visualConcept: 'Koch triangle', visualType: 'diagram', rationale: 'AV node location in right atrium anatomy boundaries', recommendedQuery: 'triangle of koch boundaries' },
    { heading: 'Anatomy', line: 250, visualConcept: 'Killian dehiscence', visualType: 'diagram', rationale: 'Pharyngeal pouch Zenker diverticulum triangle boundaries', recommendedQuery: 'killian dehiscence anatomy' }
  ];

  const lowYieldFillers = [
    { heading: 'Intro', line: 5, visualConcept: 'Nurse trolley placement', visualType: 'diagram', rationale: 'General setup in room', recommendedQuery: 'nurse trolley room setup' },
    { heading: 'Intro', line: 15, visualConcept: 'Operating room lighting', visualType: 'diagram', rationale: 'Ceiling lamp angle', recommendedQuery: 'room lighting lamp' },
    { heading: 'Intro', line: 25, visualConcept: 'Patient gown color', visualType: 'diagram', rationale: 'Cotton gown material', recommendedQuery: 'patient gown cotton' },
    { heading: 'Intro', line: 35, visualConcept: 'Sterile glove wrapper', visualType: 'diagram', rationale: 'Paper wrap discard', recommendedQuery: 'sterile glove paper wrapper' },
    { heading: 'Intro', line: 45, visualConcept: 'Scalpel tray layout', visualType: 'diagram', rationale: 'Steel tray arrangement', recommendedQuery: 'scalpel tray layout' },
    { heading: 'Intro', line: 55, visualConcept: 'Instrument count whiteboard', visualType: 'diagram', rationale: 'Wall marker board', recommendedQuery: 'instrument count whiteboard' },
    { heading: 'Intro', line: 65, visualConcept: 'Recovery room curtains', visualType: 'diagram', rationale: 'Curtain track divider', recommendedQuery: 'recovery room curtain divider' }
  ];

  // Interleave high yield and low yield items in scrambled line order
  const combined = [...lowYieldFillers, ...highYieldItems].sort(() => Math.random() - 0.5);
  const input = JSON.stringify({ summary: 'Mixed yield concepts', suggestions: combined });

  const result = h.GeminiScannerService.parseGeminiResponse(input, 300);

  assert.equal(result.suggestions.length, 25, 'Must cap at exactly 25 suggestions');
  // Verify all 25 are high-yield and none of the low yield fillers were selected
  for (const s of result.suggestions) {
    assert.ok(!s.visualConcept.includes('Nurse trolley'), 'Low-yield nurse trolley must be dropped');
    assert.ok(!s.visualConcept.includes('room lighting'), 'Low-yield room lighting must be dropped');
    assert.ok(!s.visualConcept.includes('gown color'), 'Low-yield gown color must be dropped');
    assert.ok(!s.visualConcept.includes('glove wrapper'), 'Low-yield glove wrapper must be dropped');
    assert.ok(!s.visualConcept.includes('tray layout'), 'Low-yield tray layout must be dropped');
    assert.ok(!s.visualConcept.includes('whiteboard'), 'Low-yield whiteboard must be dropped');
    assert.ok(!s.visualConcept.includes('curtains'), 'Low-yield curtains must be dropped');
  }

  // Verify the resulting 25 are strictly sorted by ascending line number
  for (let i = 1; i < result.suggestions.length; i++) {
    assert.ok(result.suggestions[i].line >= result.suggestions[i - 1].line, `Line numbers must be ascending: ${result.suggestions[i - 1].line} <= ${result.suggestions[i].line}`);
  }
});

test('buildAltGPrompt includes explicit instructions for 3-5 keywords and clean textbook illustrations', () => {
  const h = harness();
  const prompt = h.GeminiScannerService.buildAltGPrompt('Pancreas Note', 'Pancreas anatomy\nWhipple procedure\nPassaro triangle');

  assert.ok(
    prompt.includes("CRITICAL: Keep recommendedQuery SIMPLE, CLEAN, and CONCISE (strictly 3 to 5 clear keywords, e.g. 'Whipple procedure labeled diagram', 'Double bubble sign X-ray', 'Passaro triangle diagram', 'Grey Turner Cullen sign', 'Pancreas blood supply diagram'). Avoid long, convoluted 8-12 word queries that clutter image search engines."),
    'buildAltGPrompt must instruct Gemini to keep recommendedQuery strictly 3 to 5 keywords'
  );

  assert.ok(
    prompt.includes("Recommend clean, simple textbook illustrations, anatomical diagrams, and pathognomonic clinical/radiological spotters rather than overly dense, obscure micro-cellular schematics"),
    'buildAltGPrompt must instruct Gemini to recommend clean simple textbook illustrations'
  );
});

test('sanitizeSuggestions cleans verbose filler, parentheticals, duplicate words, and simplifies queries for DuckDuckGo', () => {
  const h = harness();

  // Test 1: Query with parentheticals and clutter acronyms
  const q1 = h.GeminiScannerService.simplifySearchQuery("Whipple procedure (PJ, HJ, GJ) reconstruction surgical diagram");
  assert.ok(!q1.includes('(') && !q1.includes(')'), 'Parentheticals should be stripped');
  assert.ok(q1.includes('Whipple'), 'Primary concept preserved');
  assert.ok(q1.includes('diagram'), 'Visual type descriptor preserved');

  // Test 2: Overly verbose 8-word query from user issue
  const q2 = h.GeminiScannerService.simplifySearchQuery("Whipple pancreaticoduodenectomy reconstruction PJ HJ GJ surgical diagram");
  const words2 = q2.split(/\s+/);
  assert.ok(words2.length <= 6, `Verbose query should be simplified to <= 6 words, got: ${words2.length} (${q2})`);
  assert.ok(q2.includes('Whipple'), 'Whipple preserved');
  assert.ok(q2.includes('diagram'), 'diagram anchor preserved');

  // Test 3: Multiple procedures piled up
  const q3 = h.GeminiScannerService.simplifySearchQuery("cystogastrostomy Jurasz Roux-en-Y cystojejunostomy pancreatic pseudocyst surgery diagram");
  const words3 = q3.split(/\s+/);
  assert.ok(words3.length <= 6, `Piled procedures query should be simplified, got: ${words3.length} (${q3})`);

  // Test 4: Clutter buzzwords and search prefixes
  const q4 = h.GeminiScannerService.simplifySearchQuery("search for high-yield labeled diagram showing Hesselbach triangle inferior epigastric artery");
  assert.ok(!q4.toLowerCase().startsWith('search for'), 'Prefix search for removed');
  assert.ok(!q4.toLowerCase().includes('high-yield'), 'high-yield buzzword removed');
  assert.ok(!q4.toLowerCase().includes('showing'), 'showing removed');

  // Test 5: Word repetition
  const q5 = h.GeminiScannerService.simplifySearchQuery("pancreatic pseudocyst cystogastrostomy surgery diagram diagram");
  const diagramMatches = q5.match(/\bdiagram\b/gi) || [];
  assert.equal(diagramMatches.length, 1, 'Duplicate words should be deduplicated');

  // Test 6: Medical hyphens like Roux-en-Y, x-ray, double-bubble preserved
  const q6 = h.GeminiScannerService.simplifySearchQuery("Roux-en-Y loop double-bubble sign abdominal x-ray");
  assert.ok(q6.includes('Roux-en-Y'), 'Roux-en-Y hyphenation preserved');
  assert.ok(q6.includes('double-bubble'), 'double-bubble hyphenation preserved');
  assert.ok(q6.includes('x-ray'), 'x-ray hyphenation preserved');

  // Test 7: User complaint #3: pancreaticoduodenal arterial arcade query simplification
  const q7 = h.GeminiScannerService.simplifySearchQuery("pancreaticoduodenal arterial arcade gastroduodenal superior mesenteric artery diagram");
  const words7 = q7.split(/\s+/);
  assert.ok(words7.length <= 5, `Pancreaticoduodenal arcade query should be <= 5 words, got: ${words7.length} (${q7})`);
  assert.ok(q7.includes('pancreaticoduodenal'), 'pancreaticoduodenal entity preserved');
  assert.ok(!q7.includes('gastroduodenal diagram'), 'Should not leave broken gastroduodenal diagram fragment');
});

test('Markdown tables and lists with scrambled line numbers are strictly sorted in ascending order', () => {
  const h = harness();

  // Scrambled Markdown table
  const tableInput = `
| Line | Heading | Visual Concept | Type | Clinical Rationale | Search Query |
|---|---|---|---|---|---|
| [L450] | Pelvis | Sacrospinous ligament | Diagram | Landmark for vaginal vault suspension | sacrospinous ligament anatomy diagram |
| [L12] | Achalasia | Bird's beak sign | Radiology | Pathognomonic barium swallow | achalasia cardia bird beak sign |
| [L180] | Thyroid | Psammoma bodies | Histology | Papillary carcinoma hallmark | psammoma bodies thyroid histology |
| [L85] | Stomach | Passaro triangle | Diagram | Gastrinoma triangle boundaries | passaro triangle boundaries diagram |
`;
  const tableRes = h.GeminiScannerService.parseGeminiResponse(tableInput, 500);
  assert.equal(tableRes.suggestions.length, 4);
  const tableLines = tableRes.suggestions.map(s => s.line);
  assert.deepEqual(JSON.stringify(tableLines), JSON.stringify([12, 85, 180, 450]));

  // Scrambled Markdown list
  const listInput = `
1. **Heading**: Hernia
   - **Line**: [L900]
   - **Concept**: Bassini repair
   - **Type**: Clinical
   - **Rationale**: Inguinal hernia repair
   - **Query**: bassini hernia repair diagram

2. **Heading**: Liver
   - **Line**: [L15]
   - **Concept**: Couinaud segments
   - **Type**: Diagram
   - **Rationale**: Hepatectomy functional segments
   - **Query**: couinaud liver segments diagram

3. **Heading**: Colon
   - **Line**: [L320]
   - **Concept**: Coffee bean sign
   - **Type**: Radiology
   - **Rationale**: Sigmoid volvulus
   - **Query**: sigmoid volvulus coffee bean x-ray
`;
  const listRes = h.GeminiScannerService.parseGeminiResponse(listInput, 1000);
  assert.equal(listRes.suggestions.length, 3);
  const listLines = listRes.suggestions.map(s => s.line);
  assert.deepEqual(JSON.stringify(listLines), JSON.stringify([15, 320, 900]));
});

test('JSON response with scrambled string line formats [L<number>] parses line numbers and strictly sorts ascending', () => {
  const h = harness();
  // Exact scrambled line numbers from user complaint: [1678, 34, 60, 52, 107, 123, 1604, 207, 293, 1872]
  const rawScrambled = [
    { heading: 'Pancreas', line: '[L1678]', visualConcept: 'Whipple reconstruction', visualType: 'diagram', recommendedQuery: 'Whipple procedure labeled diagram' },
    { heading: 'Anatomy', line: 'L34', visualConcept: 'Hesselbach triangle', visualType: 'diagram', recommendedQuery: 'Hesselbach triangle anatomy diagram' },
    { heading: 'Radiology', line: 'Line 60', visualConcept: 'Bird-beak sign', visualType: 'radiology', recommendedQuery: 'bird beak sign barium swallow' },
    { heading: 'Pathology', line: '[L52]', visualConcept: 'Reed-Sternberg cells', visualType: 'histology', recommendedQuery: 'reed sternberg cells histology' },
    { heading: 'Criteria', line: '107', visualConcept: 'Child-Pugh score', visualType: 'criteria', recommendedQuery: 'child pugh score table' },
    { heading: 'Physiology', line: '[L 123]', visualConcept: 'Frank-Starling curve', visualType: 'embryology', recommendedQuery: 'frank starling curve physiology' },
    { heading: 'Surgery', line: '[L1604]', visualConcept: 'Passaro triangle', visualType: 'diagram', recommendedQuery: 'passaro triangle diagram' },
    { heading: 'Clinical', line: '207', visualConcept: 'Grey Turner Cullen sign', visualType: 'clinical', recommendedQuery: 'grey turner cullen sign' },
    { heading: 'Radiology', line: '[L293]', visualConcept: 'Double bubble sign', visualType: 'radiology', recommendedQuery: 'double bubble sign x-ray' },
    { heading: 'Surgery', line: '[L1872]', visualConcept: 'Pancreas blood supply', visualType: 'diagram', recommendedQuery: 'pancreas blood supply diagram' }
  ];

  const input = JSON.stringify({ summary: 'Scrambled string lines', suggestions: rawScrambled });
  const result = h.GeminiScannerService.parseGeminiResponse(input, 2000);

  assert.equal(result.suggestions.length, 10);
  const actualLines = result.suggestions.map(s => s.line);
  // Verify none became 1 or NaN
  assert.ok(!actualLines.includes(NaN), 'No line number should be NaN');
  // Expected sorted: 34, 52, 60, 107, 123, 207, 293, 1604, 1678, 1872
  const expectedSorted = [34, 52, 60, 107, 123, 207, 293, 1604, 1678, 1872];
  assert.equal(JSON.stringify(actualLines), JSON.stringify(expectedSorted), 'Lines must be parsed from string tokens and strictly sorted ascending');
});

test('suggestions respect custom maxSuggestions limit up to 50 and sort ascending', () => {
  const h = harness();
  const items = Array.from({ length: 60 }, (_, idx) => ({
    heading: `Section ${idx + 1}`,
    line: (60 - idx) * 10,
    visualConcept: idx < 30 ? `Triangle of Calot ${idx}` : `Generic room setup ${idx}`,
    visualType: 'diagram',
    rationale: idx < 30 ? 'High-yield boundaries for cholecystectomy exam' : 'General room setup',
    recommendedQuery: idx < 30 ? 'triangle of calot boundaries' : 'room setup'
  }));

  const input = JSON.stringify({ summary: '60 suggestions', suggestions: items });

  // 1. Pass maxSuggestions = 25
  const res25 = h.GeminiScannerService.parseGeminiResponse(input, 1000, 25);
  assert.equal(res25.suggestions.length, 25, 'Must cap at 25 when maxSuggestions = 25');

  // 2. Pass maxSuggestions = 30
  const res30 = h.GeminiScannerService.parseGeminiResponse(input, 1000, 30);
  assert.equal(res30.suggestions.length, 30, 'Must cap at 30 when maxSuggestions = 30');

  // 3. Pass maxSuggestions = 100 (capped at hard ceiling 50)
  const res50 = h.GeminiScannerService.parseGeminiResponse(input, 1000, 100);
  assert.equal(res50.suggestions.length, 50, 'Must cap at maximum 50 when maxSuggestions > 50');

  // Verify strictly sorted by line ascending
  for (let i = 1; i < res30.suggestions.length; i++) {
    assert.ok(res30.suggestions[i].line >= res30.suggestions[i - 1].line, 'Resulting suggestions must be sorted by line ascending');
  }
});
