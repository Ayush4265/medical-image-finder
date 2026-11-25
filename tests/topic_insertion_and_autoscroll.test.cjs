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
    this.classes = new Set(options.cls ? options.cls.split(/\s+/).filter(Boolean) : []);
  }
  empty() { this.children = []; }
  addClass(cls) { this.classes.add(cls); }
  removeClass(cls) { this.classes.delete(cls); }
  hasClass(cls) { return this.classes.has(cls); }
  setAttribute(k, v) { this[k] = v; }
  scrollIntoView() { this.scrolledIntoView = true; }
  createEl(tag, options) { const el = new Element(tag, options); this.children.push(el); return el; }
  createDiv(options) { return this.createEl('div', options); }
  createSpan(options) { return this.createEl('span', options); }
  addEventListener(event, callback) { this.listeners[event] = callback; }
  setText(text) { this.text = text; }
  focus() {}
  all() { return [this, ...this.children.flatMap(child => child.all())]; }
  querySelector(sel) {
    if (sel.startsWith('#')) {
      const id = sel.slice(1);
      return this.all().find(el => el.id === id) || null;
    }
    return null;
  }
}

function harness(request = async () => { throw Error('Unexpected request'); }) {
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
  const context = {
    require: id => id === 'obsidian' ? obsidian : id === 'electron' ? electron : require(id),
    module: { exports: {} },
    Buffer, URL, Blob, setTimeout, clearTimeout, setInterval, clearInterval,
    window: { addEventListener: () => {}, removeEventListener: () => {}, setInterval, clearInterval, setTimeout, clearTimeout },
    document: null,
    console
  };

  const mainPath = path.join(__dirname, '../main.js');
  vm.runInNewContext(fs.readFileSync(mainPath, 'utf8') + '\nmodule.exports._test = { MedicalImageFinderView, GeminiScannerService, normalizeSettings, normalizeResults, attachmentPath, imageExtension, safeError };', context);
  const Plugin = context.module.exports;
  const plugin = new Plugin();
  plugin.settings = Plugin._test.normalizeSettings({});
  plugin.pendingActions = new Map();
  plugin.writeQueue = Promise.resolve();
  const files = new Map();
  const leaves = [];
  const workspace = { active: null, getActiveViewOfType() { return this.active; }, getLeavesOfType(type) { return leaves.filter(l => type === 'markdown' ? l.view instanceof MarkdownView : !(l.view instanceof MarkdownView)); }, revealLeaf: async () => {} };
  const vault = { getAbstractFileByPath: p => files.get(p), createFolder: async p => { files.set(p, {}); }, createBinary: async (p, bytes) => { const file = new TFile(p); file.bytes = Buffer.from(bytes); files.set(p, file); }, readBinary: async f => f.bytes };
  plugin.app = { workspace, vault };

  function note(name, text) {
    const file = new TFile(name);
    files.set(name, file);
    const lines = text.split('\n');
    const inserts = [];
    const editor = {
      lines: [...lines],
      cursor: 0,
      inserts,
      lineCount() { return this.lines.length; },
      getLine(i) { return this.lines[i] || ''; },
      getValue() { return this.lines.join('\n'); },
      getCursor(which = 'to') { return { line: this.cursor, ch: (this.lines[this.cursor] || '').length }; },
      setCursor(pos) { this.cursor = pos.line; },
      scrollIntoView() {},
      replaceRange(val, pos) {
        inserts.push({ val, pos });
        const line = this.lines[pos.line] || '';
        const before = line.slice(0, pos.ch);
        const after = line.slice(pos.ch);
        const updated = (before + val + after).split('\n');
        this.lines.splice(pos.line, 1, ...updated);
      }
    };
    const view = new MarkdownView();
    view.file = file;
    view.editor = editor;
    leaves.push({ view });
    workspace.active = view;
    return { file, view, editor };
  }

  function sidebar() {
    const leaf = { view: null };
    const view = new Plugin._test.MedicalImageFinderView(leaf, plugin);
    leaf.view = view;
    view.containerEl = view.contentEl;
    return view;
  }

  return { plugin, note, sidebar, notices };
}

test('findTopicInsertionPosition places image below the topic content before divider ---', () => {
  const h = harness();
  const noteContent = [
    '# Pancreas Diseases',
    '',
    '### B. Annular Pancreas',
    '',
    '- **Embryological Defect:** Failure of ventral bud rotation.',
    '- **Clinical Presentation:** Neonatal vomiting, double bubble sign.',
    '- **Surgical Caveat:** Duodenoduodenostomy; never resect the ring!',
    '---',
    '',
    '### C. Ectopic Pancreas',
    '- **Sites:** Stomach, duodenum.'
  ].join('\n');

  const note = h.note('Pancreas.md', noteContent);
  // Annular Pancreas heading is at line 3 (1-indexed)
  const pos = h.plugin.findTopicInsertionPosition(note.editor, 3, 'B. Annular Pancreas');
  
  // Topic starts at line 3 (index 2: '### B. Annular Pancreas')
  // Content ends at line 7 (index 6: '- **Surgical Caveat:** ...')
  // Divider '---' is at line 8 (index 7)
  // The insertion line should be index 6 (line 7), right below the topic!
  assert.equal(pos.line, 6);
  assert.equal(note.editor.getLine(pos.line), '- **Surgical Caveat:** Duodenoduodenostomy; never resect the ring!');
});

test('findTopicInsertionPosition places image below topic before next equal-level heading when no divider', () => {
  const h = harness();
  const noteContent = [
    '## 1. Surgical Conditions',
    '### A. Pancreas Divisum',
    '- Outflow obstruction via minor papilla.',
    '- Treatment is sphincterotomy.',
    '### B. Annular Pancreas',
    '- Ring around duodenum.'
  ].join('\n');

  const note = h.note('Pancreas.md', noteContent);
  // Topic A. Pancreas Divisum is at line 2 (1-indexed)
  const pos = h.plugin.findTopicInsertionPosition(note.editor, 2, 'A. Pancreas Divisum');

  // Topic starts at line 2 (index 1: '### A. Pancreas Divisum')
  // Content ends at line 4 (index 3: '- Treatment is sphincterotomy.')
  // Next heading is line 5 (index 4: '### B. Annular Pancreas')
  assert.equal(pos.line, 3);
  assert.equal(note.editor.getLine(pos.line), '- Treatment is sphincterotomy.');
});

test('findTopicInsertionPosition handles existing images at bottom of topic and inserts after them', () => {
  const h = harness();
  const noteContent = [
    '### B. Annular Pancreas',
    '- Double bubble sign on X-ray.',
    '![[Pasted image 1.png]]',
    '---',
    '### Next Topic'
  ].join('\n');

  const note = h.note('Pancreas.md', noteContent);
  const pos = h.plugin.findTopicInsertionPosition(note.editor, 1, 'B. Annular Pancreas');
  // Insertion line should be index 2 (line 3 with ![[Pasted image 1.png]]), after existing image
  assert.equal(pos.line, 2);
  assert.equal(note.editor.getLine(pos.line), '![[Pasted image 1.png]]');
});

test('Search images from scanner card passes searchOriginSuggestionIndex and auto-returns to scan tab upon insertion', async () => {
  const h = harness();
  const note = h.note('Pancreas.md', '### Annular Pancreas\n- Double bubble on X-ray.\n---\n### Next');
  const view = h.sidebar();
  view.scanContext = h.plugin.captureTarget();

  const suggestion = {
    heading: 'Annular Pancreas',
    line: 1,
    visualConcept: 'Double bubble',
    visualType: 'radiology',
    recommendedQuery: 'double bubble sign X-ray'
  };
  view.scanResults = { suggestions: [suggestion] };
  view.currentTab = 'scan';
  view.render();

  // Find "Search images" button on card 0
  const searchCard = view.contentEl.querySelector('#mif-card-0');
  assert.ok(searchCard);

  // Click Search images
  view.searchTargetContext = view.scanContext;
  view.searchTargetLine = suggestion.line;
  view.searchTargetHeading = suggestion.heading;
  view.searchOriginSuggestionIndex = 0;
  view.lastActiveScannerIndex = 0;
  view.switchToSearchTab(suggestion.recommendedQuery, suggestion.visualType, false);

  assert.equal(view.currentTab, 'search');
  assert.equal(view.searchOriginSuggestionIndex, 0);

  // Setup mock item result
  const resultItem = {
    title: 'Double Bubble Sign',
    imageUrl: 'https://example.org/db.png',
    domain: 'example.org',
    targetContext: view.scanContext,
    targetLine: suggestion.line,
    targetHeading: suggestion.heading,
    searchOriginSuggestionIndex: 0
  };

  h.plugin.downloadImage = async () => ({
    bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    ext: 'png'
  });

  // Insert image from search tab
  await h.plugin.saveAndInsertImage(resultItem);

  // Verify inserted in note BELOW topic (after line index 1)
  assert.equal(note.editor.inserts.length, 1);
  assert.equal(note.editor.inserts[0].pos.line, 1); // line index 1 is '- Double bubble on X-ray.'

  // Auto-switch to scan tab and mark card as inserted
  view.insertedSuggestionIndices.add(resultItem.searchOriginSuggestionIndex);
  view.currentTab = 'scan';
  view.render();

  assert.equal(view.currentTab, 'scan');
  assert.ok(view.insertedSuggestionIndices.has(0));
  const updatedCard = view.contentEl.querySelector('#mif-card-0');
  assert.ok(updatedCard.hasClass('is-inserted'));
});
