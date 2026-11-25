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
    this.value = options.attr?.value || options.value || '';
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
    if (sel.startsWith('.')) {
      const cls = sel.slice(1);
      return this.all().find(el => el.hasClass(cls)) || null;
    }
    return null;
  }
  querySelectorAll(sel) {
    if (sel.startsWith('.')) {
      const cls = sel.slice(1);
      return this.all().filter(el => el.hasClass(cls));
    }
    return [];
  }
}

function createHarness(customRequest = null) {
  const notices = [];
  let clipboardText = '';
  let harnessRequestUrl = customRequest || (async () => ({ status: 200, json: {}, text: '{}' }));

  class TFile {
    constructor(name) {
      this.path = name;
      this.basename = name.replace(/\.md$/, '');
      this.extension = name.endsWith('.md') ? 'md' : 'png';
    }
  }
  class MarkdownView {}
  class ItemView {
    constructor(leaf) {
      this.leaf = leaf;
      this.contentEl = new Element();
    }
  }
  class Modal {
    constructor(app) {
      this.app = app;
      this.contentEl = new Element();
      this.titleEl = new Element();
    }
    open() { this.onOpen?.(); }
    close() { this.onClose?.(); }
  }
  class PluginSettingTab {
    constructor(app, plugin) {
      this.app = app;
      this.plugin = plugin;
    }
  }

  const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const electron = {
    nativeImage: {
      createFromBuffer: bytes => ({
        isEmpty: () => !bytes.length || bytes[0] === 60,
        toPNG: () => pngHeader
      })
    },
    clipboard: {
      writeText: (t) => { clipboardText = t; },
      readText: () => clipboardText,
      writeImage: () => {}
    },
    shell: { openExternal: () => {} }
  };

  const sandbox = {
    require: (mod) => {
      if (mod === 'obsidian') {
        return {
          Plugin: class { constructor(app, manifest) { this.app = app; this.manifest = manifest; } },
          ItemView,
          Modal,
          PluginSettingTab,
          MarkdownView,
          Setting: class {
            constructor(container) { this.container = container; }
            setName() { return this; }
            setDesc() { return this; }
            addDropdown() { return this; }
          },
          Notice: class { constructor(msg) { notices.push(String(msg)); this.msg = msg; } },
          TFile,
          normalizePath: p => p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''),
          requestUrl: (opts) => harnessRequestUrl(opts)
        };
      }
      if (mod === 'electron') return electron;
      if (mod === 'node:crypto') return require('node:crypto');
      return require(mod);
    },
    module: { exports: {} },
    console,
    Buffer,
    setTimeout,
    clearTimeout,
    URL,
    Blob,
    Image: class { set src(v) { setTimeout(() => this.onload?.(), 0); } }
  };

  const code = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  vm.createContext(sandbox);
  vm.runInContext(
    code + '\nmodule.exports._test = { GeminiScannerService, WikimediaProvider, BrightDataProvider, BatchImageReviewModal, MedicalImageFinderView, normalizeSettings };',
    sandbox
  );

  return {
    PluginClass: sandbox.module.exports,
    _test: sandbox.module.exports._test,
    setRequestUrl: (fn) => { harnessRequestUrl = fn; },
    TFile,
    MarkdownView,
    notices
  };
}

test('getEffectiveQuery avoids redundant modality bloat when query already specifies visual type', () => {
  const h = createHarness();
  const plugin = new h.PluginClass({ vault: {}, workspace: { getLeavesOfType: () => [], getActiveViewOfType: () => null } }, {});
  plugin.settings = h._test.normalizeSettings({});
  const view = new h._test.MedicalImageFinderView({ leaf: {} }, plugin);

  assert.equal(view.getEffectiveQuery('double bubble sign X-ray', 'radiology'), 'double bubble sign X-ray');
  assert.equal(view.getEffectiveQuery('Whipple procedure labeled diagram', 'diagram'), 'Whipple procedure labeled diagram');
  assert.equal(view.getEffectiveQuery('Reed Sternberg histology', 'histology'), 'Reed Sternberg histology');

  // Plain terms get concise 2-word modifiers
  assert.equal(view.getEffectiveQuery('achalasia', 'radiology'), 'achalasia radiology X-ray');
  assert.equal(view.getEffectiveQuery('Calot triangle', 'diagram'), 'Calot triangle labeled diagram');
});

test('WikimediaProvider requests 1000px thumbs and prefers PNG thumburl for TIFF files', async () => {
  const h = createHarness(async (opts) => {
    assert.ok(opts.url.includes('iiurlwidth=1000'));
    return {
      status: 200,
      json: {
        query: {
          pages: {
            '1': {
              title: 'File:CT_scan_volvulus.tif',
              imageinfo: [{
                mime: 'image/tiff',
                url: 'https://upload.wikimedia.org/wikipedia/commons/a/a1/CT_scan_volvulus.tif',
                thumburl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a1/CT_scan_volvulus.tif/1000px-CT_scan_volvulus.tif.png',
                descriptionurl: 'https://commons.wikimedia.org/wiki/File:CT_scan_volvulus.tif',
                width: 1200,
                height: 900
              }]
            },
            '2': {
              title: 'File:Calot_triangle.png',
              imageinfo: [{
                mime: 'image/png',
                url: 'https://upload.wikimedia.org/wikipedia/commons/b/b2/Calot_triangle.png',
                thumburl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b2/Calot_triangle.png/1000px-Calot_triangle.png',
                descriptionurl: 'https://commons.wikimedia.org/wiki/File:Calot_triangle.png',
                width: 1000,
                height: 800
              }]
            }
          }
        }
      }
    };
  });

  const provider = new h._test.WikimediaProvider();
  const res = await provider.search('volvulus');
  assert.equal(res.length, 2);
  assert.ok(res[0].imageUrl.endsWith('.png'), 'TIFF entry must use rendered PNG thumburl as imageUrl');
  assert.equal(res[1].imageUrl, 'https://upload.wikimedia.org/wikipedia/commons/b/b2/Calot_triangle.png');
});

test('BrightDataProvider prefers webpage link for sourceUrl over raw original_image', async () => {
  const h = createHarness(async () => ({
    status: 200,
    json: {
      images: [
        {
          title: 'TeachMeAnatomy',
          image: 'https://encrypted-tbn0.gstatic.com/images?q=tbn:1',
          original_image: 'https://teachmeanatomy.info/wp-content/uploads/calot.jpg',
          link: 'https://teachmeanatomy.info/abdomen/viscera/gallbladder/'
        }
      ]
    }
  }));

  const provider = new h._test.BrightDataProvider('bd-key', 'serp_api1');
  const res = await provider.search('calot triangle');
  assert.equal(res.length, 1);
  assert.equal(res[0].imageUrl, 'https://teachmeanatomy.info/wp-content/uploads/calot.jpg');
  assert.equal(res[0].sourceUrl, 'https://teachmeanatomy.info/abdomen/viscera/gallbladder/');
});

test('_buildDigest samples full note beyond 400 lines while keeping exact [L<number>] prefixes', () => {
  const h = createHarness();
  const lines = [];
  for (let i = 1; i <= 900; i++) {
    if (i === 1) lines.push('# Start Heading');
    else if (i === 850) lines.push('## Late Section Near End');
    else lines.push(`Content line ${i}`);
  }
  const digest = h._test.GeminiScannerService._buildDigest(lines);
  assert.ok(digest.includes('[L1] # Start Heading'));
  assert.ok(digest.includes('[L850] ## Late Section Near End'), 'Must preserve headings beyond line 400');
});

test('generateImageMarkdown expands tab-indented bullets cleanly without inserting raw tabs', () => {
  const h = createHarness();
  const plugin = new h.PluginClass({ vault: {}, workspace: {} }, {});
  const editor = {
    lines: ['\t- Nested bullet point'],
    lineCount: () => 1,
    getLine: (i) => editor.lines[i] || ''
  };
  const md = plugin.generateImageMarkdown(editor, { line: 0, ch: 21 }, 'Attachments/img.png', 500, false, null);
  assert.equal(md, '\n      ![[Attachments/img.png|500]]');
  assert.ok(!md.includes('\t'));
});

test('BatchImageReviewModal preserves thumbnails on partial insert failure and supports Enter-to-search', async () => {
  const h = createHarness();
  const mockFile = new h.TFile('Note.md');
  const mockEditor = {
    lineCount: () => 2,
    getLine: () => '## Topic',
    getValue: () => '## Topic\nDetails',
    getCursor: () => ({ line: 0, ch: 0 }),
    replaceRange: () => {}
  };
  const mockView = { file: mockFile, editor: mockEditor };
  const mockContext = { view: mockView, file: mockFile, editor: mockEditor, path: 'Note.md', content: '## Topic\nDetails' };

  const plugin = new h.PluginClass({
    vault: { getAbstractFileByPath: (p) => p === 'Note.md' ? mockFile : null, createFolder: async () => {} },
    workspace: { getLeavesOfType: () => [{ view: mockView }] }
  }, {});
  plugin.settings = h._test.normalizeSettings({ defaultProvider: 'brightdata', brightDataApiKey: 'key' });
  plugin.writeQueue = Promise.resolve();
  plugin.batchInsertImages = async () => ({
    insertedCount: 1,
    successfulIndices: new Set([0]),
    failedIndices: new Set([1])
  });

  const view = {
    scanResults: {
      suggestions: [
        { heading: 'Topic 1', line: 1, visualConcept: 'C1', visualType: 'diagram', recommendedQuery: 'q1' },
        { heading: 'Topic 2', line: 2, visualConcept: 'C2', visualType: 'diagram', recommendedQuery: 'q2' }
      ]
    },
    scanContext: mockContext,
    insertedSuggestionIndices: new Set(),
    getEffectiveQuery: (q) => q,
    render: () => {}
  };

  const modal = new h._test.BatchImageReviewModal({}, plugin, view);
  let fetchCalls = 0;
  modal.fetchSingleItem = async (rItem) => {
    fetchCalls++;
    rItem.items = [
      { title: 'Img 1', imageUrl: 'https://example.com/1.png' },
      { title: 'Img 2', imageUrl: 'https://example.com/2.png' }
    ];
    rItem.loading = false;
    rItem.included = true;
    rItem.selectedIndices = [0];
    rItem.selectedIdx = 0;
    return { cached: true };
  };

  await modal.onOpen();
  assert.equal(fetchCalls, 2);

  // Trigger batch insert where topic 2 fails
  await modal.insertBtn.onclick();
  const card1 = modal.contentEl.querySelector('#mif-batch-card-1');
  assert.ok(card1.querySelector('.mif-batch-insert-warn'), 'Failed card should display insert warning');
  assert.equal(card1.querySelectorAll('.mif-batch-thumb-option').length, 2, 'Failed card must preserve all candidate thumbnails');

  // Press Enter inside query input to re-search card 1
  const input1 = card1.querySelector('.mif-batch-card-query-input');
  input1.value = 'new query';
  await input1.listeners.keydown({ key: 'Enter', preventDefault: () => {} });
  assert.equal(fetchCalls, 3);
  assert.equal(modal.reviewItems[1].query, 'new query');

  modal.close();
});

test('MedicalImageFinderView resets insertedSuggestionIndices on new scan and shows Offline Scan button without API keys', async () => {
  const h = createHarness();
  const plugin = new h.PluginClass({
    vault: {},
    workspace: { getLeavesOfType: () => [], getActiveViewOfType: () => null }
  }, {});
  plugin.settings = h._test.normalizeSettings({ aiBackend: 'offline' });
  plugin.saveSettings = async () => {};

  const view = new h._test.MedicalImageFinderView({ leaf: {} }, plugin);
  view.currentTab = 'scan';
  view.insertedSuggestionIndices.add(0);
  view.insertedSuggestionIndices.add(1);
  view.render();

  const offlineBtn = view.contentEl.all().find(el => el.tag === 'button' && el.text === '⚡ Offline Scan');
  assert.ok(offlineBtn, 'Offline Scan button must render when aiBackend is offline even with no API keys');

  await view.applyScanResults({
    summary: 'Fresh scan',
    suggestions: [{ heading: 'H1', line: 1, visualConcept: 'V1', visualType: 'diagram', recommendedQuery: 'q1' }]
  });
  assert.equal(view.insertedSuggestionIndices.size, 0, 'Applying new scan results must reset inserted indices');
});

test('MedicalImageFinderView preserves scanner link when tweaking query and unlinks via banner button', () => {
  const h = createHarness();
  const plugin = new h.PluginClass({
    vault: {},
    workspace: { getLeavesOfType: () => [], getActiveViewOfType: () => null }
  }, {});
  plugin.settings = h._test.normalizeSettings({});
  const view = new h._test.MedicalImageFinderView({ leaf: {} }, plugin);

  view.searchOriginSuggestionIndex = 2;
  view.searchTargetHeading = 'Calot Triangle';
  view.searchTargetLine = 42;
  view.currentTab = 'search';
  view.render();

  view.queryInput.value = 'calot triangle modified';
  view.queryInput.listeners.input();
  assert.equal(view.searchOriginSuggestionIndex, 2, 'Editing query must keep scanner topic link');

  const unlinkBtn = view.contentEl.all().find(el => el.tag === 'button' && el.text === '✕' && el.options?.attr?.title?.includes('Unlink'));
  assert.ok(unlinkBtn, 'Scanner return banner must render unlink button');
  unlinkBtn.onclick();
  assert.equal(view.searchOriginSuggestionIndex, null);
  assert.equal(view.searchTargetLine, null);
});

test('batchInsertImages aborts cleanly with zero partial note edits if note changes during concurrent downloads', async () => {
  const h = createHarness();
  const mockFile = new h.TFile('RaceNote.md');
  let noteText = '## Section A\nLine A\n## Section B\nLine B';
  const inserts = [];
  const mockEditor = {
    lineCount: () => noteText.split('\n').length,
    getLine: (i) => noteText.split('\n')[i] || '',
    getValue: () => noteText,
    getCursor: () => ({ line: 0, ch: 0 }),
    replaceRange: (str, pos) => { inserts.push({ str, pos }); noteText += str; }
  };
  const mockView = new h.MarkdownView();
  mockView.file = mockFile;
  mockView.editor = mockEditor;
  const mockContext = { view: mockView, file: mockFile, editor: mockEditor, path: 'RaceNote.md', content: noteText };

  const plugin = new h.PluginClass({
    vault: {
      getAbstractFileByPath: (p) => p === 'RaceNote.md' ? mockFile : null,
      createFolder: async () => {},
      createBinary: async () => {}
    },
    workspace: { getLeavesOfType: (t) => t === 'markdown' ? [{ view: mockView }] : [] }
  }, {});
  plugin.settings = h._test.normalizeSettings({});
  plugin.writeQueue = Promise.resolve();

  let dlCount = 0;
  plugin.downloadImage = async () => {
    dlCount++;
    if (dlCount === 1) {
      noteText += '\nUser typed something during download!';
    }
    return { bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]), ext: 'png' };
  };

  const jobs = [
    { suggestionIndex: 0, targetLine: 2, targetHeading: 'Section A', targetConcept: 'A', targetQuery: 'A', imageItem: { title: 'A', imageUrl: 'https://example.com/a.png', targetContext: mockContext } },
    { suggestionIndex: 1, targetLine: 4, targetHeading: 'Section B', targetConcept: 'B', targetQuery: 'B', imageItem: { title: 'B', imageUrl: 'https://example.com/b.png', targetContext: mockContext } }
  ];

  await assert.rejects(plugin.batchInsertImages(jobs), /changed or closed/);
  assert.equal(inserts.length, 0, 'Must perform zero partial editor edits if note changed during downloads');
});

test('WikimediaProvider sorts by index and uses rendered PNG thumburl for SVG files', async () => {
  const h = createHarness(async () => ({
    status: 200,
    json: {
      query: {
        pages: {
          '99': {
            index: 2,
            title: 'File:Second_result.png',
            imageinfo: [{ mime: 'image/png', url: 'https://upload.wikimedia.org/second.png', thumburl: 'https://upload.wikimedia.org/thumb_second.png', width: 800, height: 600 }]
          },
          '12': {
            index: 1,
            title: 'File:First_diagram.svg',
            imageinfo: [{ mime: 'image/svg+xml', url: 'https://upload.wikimedia.org/first.svg', thumburl: 'https://upload.wikimedia.org/1000px-first.svg.png', width: 1000, height: 700 }]
          }
        }
      }
    }
  }));
  const res = await new h._test.WikimediaProvider().search('anatomy');
  assert.equal(res.length, 2);
  assert.equal(res[0].title, 'First_diagram');
  assert.equal(res[0].imageUrl, 'https://upload.wikimedia.org/1000px-first.svg.png');
  assert.equal(res[1].title, 'Second_result');
});

test('BrightDataProvider returns [] on empty images grid and unwraps Google /url?q= redirects', async () => {
  const h = createHarness(async () => ({
    status: 200,
    json: { general: { query: 'obscure' }, images: [] }
  }));
  const bd = new h._test.BrightDataProvider('bd-key', 'serp_api1');
  const emptyRes = await bd.search('obscure');
  assert.equal(Array.isArray(emptyRes), true);
  assert.equal(emptyRes.length, 0);

  h.setRequestUrl(async () => ({
    status: 200,
    json: {
      images: [{
        title: 'Radiopaedia',
        image: 'https://encrypted-tbn0.gstatic.com/images?q=t1',
        original_image: 'https://prod-images.radiopaedia.org/img.jpg',
        link: 'https://www.google.com/url?q=https://radiopaedia.org/cases/volvulus&sa=U'
      }]
    }
  }));
  const res = await bd.search('volvulus');
  assert.equal(res[0].sourceUrl, 'https://radiopaedia.org/cases/volvulus');
});

test('_buildDigest covers late-note content on >400-line long-paragraph notes and simplifySearchQuery keeps CT MRI', () => {
  const h = createHarness();
  const lines = [];
  for (let i = 1; i <= 700; i++) {
    lines.push(`Paragraph line ${i} ` + 'x'.repeat(220));
  }
  const digest = h._test.GeminiScannerService._buildDigest(lines);
  assert.ok(digest.length <= 28000);
  assert.ok(digest.includes('[L1] '), 'Must include start of note');
  assert.ok(/\[L6[5-9]\d\]/.test(digest) || digest.includes('[L700]'), 'Must sample near the end of long notes');

  const q = h._test.GeminiScannerService.simplifySearchQuery('CT MRI acute pancreatitis necrosis');
  assert.ok(q.includes('CT MRI'), 'Must preserve 2-term radiology modality pairs');
});

test('MedicalImageFinderView forwards targetConcept/Query, clears stale link on editor command, and updates scan warning in place', async () => {
  const h = createHarness();
  const mockFile = new h.TFile('Note.md');
  let noteText = '# Surgery\n- Calot triangle boundaries';
  const mockEditor = {
    lineCount: () => noteText.split('\n').length,
    getLine: (i) => noteText.split('\n')[i] || '',
    getValue: () => noteText,
    getSelection: () => 'inguinal canal',
    getCursor: () => ({ line: 0, ch: 0 })
  };
  const mockView = new h.MarkdownView();
  mockView.file = mockFile;
  mockView.editor = mockEditor;
  const plugin = new h.PluginClass({
    vault: { getAbstractFileByPath: (p) => p === 'Note.md' ? mockFile : null },
    workspace: {
      getLeavesOfType: (t) => t === 'markdown' ? [{ view: mockView }] : [{ view: sidebar }],
      getActiveViewOfType: () => mockView,
      revealLeaf: async () => {}
    }
  }, {});
  plugin.settings = h._test.normalizeSettings({});
  plugin.searchCache = { clear() { this.cleared = true; }, get: () => null, set: () => {} };
  plugin.getActiveProvider = () => ({ name: 'mock', search: async () => [{ title: 'Img', imageUrl: 'https://example.com/i.png' }] });

  const sidebar = new h._test.MedicalImageFinderView({ leaf: {} }, plugin);
  sidebar.scanContext = plugin.captureTarget();
  sidebar.scanResults = {
    summary: 'ok',
    suggestions: [{ heading: 'Surgery', line: 1, visualConcept: 'Calot Triangle', visualType: 'diagram', recommendedQuery: 'calot triangle diagram' }]
  };
  sidebar.currentTab = 'scan';
  sidebar.render();

  const searchBtn = sidebar.contentEl.all().find(el => el.tag === 'button' && el.text === '🔍 Search images');
  searchBtn.onclick();
  await new Promise(r => setTimeout(r, 10));
  assert.equal(sidebar.results[0].targetConcept, 'Calot Triangle');
  assert.equal(sidebar.results[0].targetQuery, 'calot triangle diagram');

  // Running Find images from editor must clear scanner origin link
  await plugin.triggerSearchFromEditor(mockEditor, mockView);
  assert.equal(sidebar.searchOriginSuggestionIndex, null);
  assert.equal(sidebar.searchTargetConcept, null);

  // Switch back to scan tab and test lightweight updateScanContextStatus
  sidebar.currentTab = 'scan';
  sidebar.render();
  const cardBefore = sidebar.contentEl.querySelector('#mif-card-0');
  noteText += '\nEdited line';
  sidebar.updateScanContextStatus();
  const cardAfter = sidebar.contentEl.querySelector('#mif-card-0');
  assert.equal(cardBefore, cardAfter, 'updateScanContextStatus must not tear down scanner cards');
  assert.ok(sidebar._scanWarningSlot.querySelector('.is-error'), 'Warning slot must show stale note error');
});

test('BatchImageReviewModal discards stale concurrent fetchSingleItem results and preserves vertical wheel when unscrollable', async () => {
  const h = createHarness();
  const plugin = new h.PluginClass({ vault: {}, workspace: { getLeavesOfType: () => [], getActiveViewOfType: () => null } }, {});
  plugin.settings = h._test.normalizeSettings({ defaultProvider: 'duckduckgo' });

  let resolveFirst;
  let call = 0;
  plugin.getProvider = () => ({
    name: 'mock',
    search: () => new Promise((res) => {
      call++;
      if (call === 1) resolveFirst = res;
      else res([{ title: 'Fresh Result', imageUrl: 'https://example.com/fresh.png' }]);
    })
  });

  const view = {
    scanResults: { suggestions: [{ heading: 'H', line: 1, visualConcept: 'C', visualType: 'diagram', recommendedQuery: 'q' }] },
    insertedSuggestionIndices: new Set(),
    getEffectiveQuery: (q) => q,
    render: () => {}
  };
  const modal = new h._test.BatchImageReviewModal({}, plugin, view);
  modal.reviewItems = [{ suggestion: { _idx: 0, line: 1, heading: 'H', visualConcept: 'C' }, query: 'q', visualType: 'diagram', items: [], selectedIndices: [], included: false }];

  const firstFetch = modal.fetchSingleItem(modal.reviewItems[0], null, true);
  const secondFetch = modal.fetchSingleItem(modal.reviewItems[0], null, true);
  await secondFetch;
  resolveFirst([{ title: 'Stale Result', imageUrl: 'https://example.com/stale.png' }]);
  const firstMeta = await firstFetch;

  assert.equal(firstMeta.stale, true);
  assert.equal(modal.reviewItems[0].items[0].title, 'Fresh Result', 'Stale completion must not overwrite newer result');

  // Verify wheel handler does not block vertical scroll when row has no horizontal overflow
  const card = new Element('div');
  modal.reviewItems[0].loading = false;
  modal.reviewItems[0].error = null;
  modal.populateCard(card, modal.reviewItems[0]);
  const optionsRow = card.querySelector('.mif-batch-options-row');
  optionsRow.scrollWidth = 300;
  optionsRow.clientWidth = 300;
  optionsRow.scrollLeft = 0;
  let prevented = false;
  optionsRow.listeners.wheel({ deltaY: 100, shiftKey: false, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false, 'Must not hijack vertical wheel when row does not overflow horizontally');

  optionsRow.scrollWidth = 600;
  optionsRow.listeners.wheel({ deltaY: 100, shiftKey: false, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true, 'Must scroll horizontally when overflow exists');
  assert.equal(optionsRow.scrollLeft, 100);
});

test('findTopicInsertionPosition prefers closest exact heading match and saveSettings({ clearCache: false }) preserves cache', async () => {
  const h = createHarness();
  const plugin = new h.PluginClass({ vault: {}, workspace: { getLeavesOfType: () => [], getActiveViewOfType: () => null } }, {});
  plugin.settings = h._test.normalizeSettings({});
  let cleared = 0;
  plugin.searchCache = { clear() { cleared++; } };
  plugin.saveData = async () => {};

  await plugin.saveSettings({ clearCache: false });
  assert.equal(cleared, 0, 'saveSettings({ clearCache: false }) must preserve searchCache');
  await plugin.saveSettings();
  assert.equal(cleared, 1, 'saveSettings() must clear searchCache by default');

  const lines = [
    '## Surgery',
    '- General surgery point',
    '## Surgery Complications',
    '- Anastomotic leak management'
  ];
  const editor = {
    lineCount: () => lines.length,
    getLine: (i) => lines[i] || '',
    getCursor: () => ({ line: 3, ch: 0 })
  };
  const pos = plugin.findTopicInsertionPosition(editor, 4, 'Surgery Complications', 'Anastomotic leak', 'anastomotic leak');
  assert.equal(pos.line, 3, 'Must match ## Surgery Complications instead of earlier ## Surgery');
});
