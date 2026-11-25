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
  const openedUrls = [];
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
    shell: { openExternal: (url) => { openedUrls.push(url); } }
  };

  const sandbox = {
    require: (mod) => {
      if (mod === 'obsidian') {
        return {
          Plugin: class { constructor(app, manifest) { this.app = app; this.manifest = manifest; } },
          ItemView,
          Modal,
          PluginSettingTab,
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
  vm.runInContext(code + '\nmodule.exports._test = { GeminiScannerService, OfflineMedicalScanner, GroqScannerService, MedicalImageFinderView, DuckDuckGoProvider, BraveProvider, SerpApiProvider, BrightDataProvider, BatchImageReviewModal, ImagePreviewModal, SearchCache, decodeHtmlEntities, cleanText, imageExtension, normalizeResults, openExternalUrl };', sandbox);

  return {
    PluginClass: sandbox.module.exports,
    _test: sandbox.module.exports._test,
    setRequestUrl: (fn) => { harnessRequestUrl = fn; },
    TFile,
    notices,
    openedUrls
  };
}

test('decodeHtmlEntities handles numeric entities and typographical punctuation', () => {
  const h = createHarness();
  const decode = h._test.decodeHtmlEntities;

  assert.equal(decode("Crohn&#039;s &amp; Whipple&#39;s"), "Crohn's & Whipple's");
  assert.equal(decode("Barrett&#x27;s esophagus"), "Barrett's esophagus");
  assert.equal(decode("Pancreas&nbsp;&ndash;&nbsp;Anatomy"), "Pancreas – Anatomy");
  assert.equal(decode("&ldquo;Double-Bubble&rdquo; sign"), '"Double-Bubble" sign');
  assert.equal(decode("&lt;b&gt;Liver&lt;/b&gt;"), "Liver");
});

test('SearchCache respects TTL expiration and LRU eviction', async () => {
  const h = createHarness();
  const cache = new h._test.SearchCache(3, 50); // maxSize=3, 50ms TTL

  cache.set('k1', [{ title: 'img1' }]);
  cache.set('k2', [{ title: 'img2' }]);
  cache.set('k3', [{ title: 'img3' }]);

  assert.equal(cache.get('k1')?.length, 1);
  assert.equal(cache.get('k2')?.length, 1);

  // Inserting 4th item should evict k3 (since k1 and k2 were accessed)
  cache.set('k4', [{ title: 'img4' }]);
  assert.equal(cache.get('k3'), null, 'k3 should be evicted as least recently used');
  assert.equal(cache.get('k1')?.length, 1, 'k1 should still be present');
  assert.equal(cache.get('k4')?.length, 1, 'k4 should be present');

  // Wait for TTL expiration
  await new Promise(r => setTimeout(r, 60));
  assert.equal(cache.get('k1'), null, 'Expired items should return null');
});

test('searchWithCache caches results across duplicate queries and respects bypassCache', async () => {
  const h = createHarness();
  const plugin = new h.PluginClass({ vault: {}, workspace: {} }, {});
  plugin.searchCache = new h._test.SearchCache();

  let searchCalls = 0;
  const mockProvider = {
    name: "MockEngine",
    search: async (q) => {
      searchCalls++;
      return [{ title: `Result for ${q}`, imageUrl: 'https://example.com/test.png' }];
    }
  };

  // First call: hits provider
  const res1 = await plugin.searchWithCache(mockProvider, 'pancreas anatomy');
  assert.equal(searchCalls, 1);
  assert.equal(res1.length, 1);

  // Second call with same query: served from cache without calling provider
  const res2 = await plugin.searchWithCache(mockProvider, 'pancreas anatomy');
  assert.equal(searchCalls, 1, 'Provider should NOT be called again for cached query');
  assert.equal(res2[0].title, 'Result for pancreas anatomy');

  // Third call with bypassCache: re-calls provider
  const res3 = await plugin.searchWithCache(mockProvider, 'pancreas anatomy', true);
  assert.equal(searchCalls, 2, 'Provider should be re-called when bypassCache is true');
  assert.equal(res3.length, 1);
});

test('downloadImage successfully decodes base64 data URIs without network fetch', async () => {
  const h = createHarness();
  let networkFetched = false;
  h.setRequestUrl(async () => {
    networkFetched = true;
    throw new Error('Should not make HTTP request for data URI');
  });

  const plugin = new h.PluginClass({ vault: {}, workspace: {} }, {});
  plugin.settings = { attachmentFolder: 'Attachments' };

  // 1x1 PNG data URI
  const validPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const itemWithDataUri = {
    title: 'Data URI Test',
    imageUrl: `data:image/png;base64,${validPngBase64}`,
    thumbnailUrl: `data:image/png;base64,${validPngBase64}`
  };

  const downloaded = await plugin.downloadImage(itemWithDataUri);
  assert.equal(downloaded.ext, 'png');
  assert.equal(networkFetched, false, 'Should decode data URI directly without network fetch');
  assert.ok(downloaded.bytes.length > 0);
});

test('BatchImageReviewModal aborts fetchAllCandidates if modal is closed mid-search', async () => {
  const h = createHarness();
  const plugin = new h.PluginClass({ vault: {}, workspace: {} }, {});
  plugin.settings = { defaultProvider: 'duckduckgo' };

  const view = {
    scanResults: {
      suggestions: [
        { heading: 'Topic 1', line: 10, visualConcept: 'Concept 1', visualType: 'diagram', recommendedQuery: 'q1' },
        { heading: 'Topic 2', line: 20, visualConcept: 'Concept 2', visualType: 'diagram', recommendedQuery: 'q2' },
        { heading: 'Topic 3', line: 30, visualConcept: 'Concept 3', visualType: 'diagram', recommendedQuery: 'q3' }
      ]
    },
    scanContext: null,
    insertedSuggestionIndices: new Set(),
    getEffectiveQuery: (q) => q
  };

  const modal = new h._test.BatchImageReviewModal({}, plugin, view);

  let fetchedQueries = [];
  modal.fetchSingleItem = async (item) => {
    fetchedQueries.push(item.query);
    if (fetchedQueries.length === 1) {
      // Close modal while item 1 is processing
      modal.close();
    }
  };

  await modal.onOpen();

  // Must stop after item 1 and not process item 2 or item 3
  assert.equal(fetchedQueries.length, 1, 'Should halt candidate fetching once modal is closed');
  assert.equal(modal.isClosed, true);
});

test('OfflineMedicalScanner detects short medical headings like Liver, Burns, Shock', async () => {
  const h = createHarness();
  const scanner = new h._test.OfflineMedicalScanner();

  const noteContent = [
    '## Liver',
    'Some general background paragraph here.',
    '## Burns',
    'Some details regarding fluid management here.',
    '## Shock',
    'Hypovolemic and distributive management.'
  ].join('\n');

  const results = await scanner.scanNote('Emergency Surgery', noteContent, 10);
  assert.ok(results.suggestions.length >= 3, 'Should generate fallback suggestions for short medical section titles');
  assert.ok(results.suggestions.some(s => s.heading.includes('Liver')));
  assert.ok(results.suggestions.some(s => s.heading.includes('Burns')));
  assert.ok(results.suggestions.some(s => s.heading.includes('Shock')));
});

test('GroqScannerService _buildDigest prefixes each line with [L<number>]', () => {
  const h = createHarness();
  const sampleLines = ['Line one', 'Line two', 'Line three'];
  const digest = h._test.GeminiScannerService._buildDigest(sampleLines);

  assert.ok(digest.includes('[L1] Line one'), 'Line 1 must be prefixed with [L1]');
  assert.ok(digest.includes('[L2] Line two'), 'Line 2 must be prefixed with [L2]');
  assert.ok(digest.includes('[L3] Line three'), 'Line 3 must be prefixed with [L3]');
});

test('batchInsertImages serializes in-flight write operations safely', async () => {
  const h = createHarness();
  const mockFile = new h.TFile('BatchNote.md');
  const writtenFiles = new Map();

  const mockVault = {
    getAbstractFileByPath: (p) => {
      if (p === 'BatchNote.md') return mockFile;
      return writtenFiles.has(p) ? { path: p } : null;
    },
    createBinary: async (p, buf) => { writtenFiles.set(p, buf); },
    readBinary: async (p) => writtenFiles.get(p.path || p),
    createFolder: async () => {}
  };

  let currentText = '## Section\n- Point 1\n- Point 2';
  const mockEditor = {
    lineCount: () => currentText.split('\n').length,
    getLine: (i) => currentText.split('\n')[i] || '',
    getValue: () => currentText,
    getCursor: () => ({ line: 0, ch: 0 }),
    replaceRange: (str, pos) => {
      currentText += str;
    }
  };

  const mockView = { file: mockFile, editor: mockEditor };
  const mockContext = { view: mockView, file: mockFile, editor: mockEditor, path: 'BatchNote.md', content: currentText };

  const plugin = new h.PluginClass({
    vault: mockVault,
    workspace: {
      getLeavesOfType: (t) => t === 'markdown' ? [{ view: mockView }] : []
    }
  }, {});
  plugin.settings = {
    attachmentFolder: 'Attachments',
    defaultImageWidth: 500,
    includeCaption: true
  };
  plugin.writeQueue = Promise.resolve();

  const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
  plugin.downloadImage = async () => ({
    bytes: pngBytes,
    ext: 'png',
    nativeImage: { toPNG: () => pngBytes }
  });

  const jobs = [
    {
      suggestionIndex: 0,
      targetLine: 2,
      targetHeading: 'Section',
      targetConcept: 'Point 1 diagram',
      targetQuery: 'Point 1',
      imageItem: {
        title: 'Image Point 1',
        imageUrl: 'https://example.com/p1.png',
        domain: 'example.com',
        targetContext: mockContext
      }
    }
  ];

  const batchPromise = plugin.batchInsertImages(jobs);
  assert.ok(plugin.writeQueue instanceof Promise, 'batchInsertImages must attach to writeQueue');
  await batchPromise;
  assert.ok(currentText.includes('![[Attachments/Image-Point-1-'));
});

test('BatchImageReviewModal does not auto-check already inserted suggestions upon candidate fetch', async () => {
  const h = createHarness();
  const plugin = new h.PluginClass({ vault: {}, workspace: {} }, {});
  plugin.settings = { defaultProvider: 'duckduckgo' };

  const view = {
    scanResults: {
      suggestions: [
        { heading: 'Topic 1', line: 10, visualConcept: 'Concept 1', visualType: 'diagram', recommendedQuery: 'q1' },
        { heading: 'Topic 2', line: 20, visualConcept: 'Concept 2', visualType: 'diagram', recommendedQuery: 'q2' }
      ]
    },
    scanContext: null,
    insertedSuggestionIndices: new Set([0]),
    getEffectiveQuery: (q) => q
  };

  const modal = new h._test.BatchImageReviewModal({}, plugin, view);
  modal.fetchSingleItem = async (rItem) => {
    rItem.items = [{ title: 'img', imageUrl: 'https://example.com/1.png' }];
    rItem.loading = false;
    const alreadyInserted = modal.view.insertedSuggestionIndices?.has(rItem.suggestion?._idx);
    rItem.included = !alreadyInserted;
  };

  await modal.onOpen();

  assert.equal(modal.reviewItems[0].included, false, 'Already inserted suggestion must not be auto-selected');
  assert.equal(modal.reviewItems[1].included, true, 'New uninserted suggestion should be auto-selected');
  modal.close();
});

test('BatchImageReviewModal re-search with engine passes bypassCache = true', async () => {
  const h = createHarness();
  const plugin = new h.PluginClass({ vault: {}, workspace: {} }, {});
  plugin.settings = { defaultProvider: 'duckduckgo' };

  const view = {
    scanResults: {
      suggestions: [
        { heading: 'Topic 1', line: 10, visualConcept: 'Concept 1', visualType: 'diagram', recommendedQuery: 'q1' }
      ]
    },
    scanContext: null,
    insertedSuggestionIndices: new Set(),
    getEffectiveQuery: (q) => q
  };

  const modal = new h._test.BatchImageReviewModal({}, plugin, view);
  let capturedBypass = null;
  modal.fetchSingleItem = async (rItem, providerId, bypassCache) => {
    capturedBypass = bypassCache;
    rItem.items = [{ title: 'img', imageUrl: 'https://example.com/1.png' }];
    rItem.loading = false;
  };

  await modal.onOpen();
  assert.equal(capturedBypass, false, 'Initial open should use cache if available');

  const refreshBtn = modal.contentEl.querySelector('.mif-btn-refresh-all');
  assert.ok(refreshBtn != null, 'Refresh all button should exist');
  refreshBtn.onclick();
  assert.equal(capturedBypass, true, 'Re-search All with Engine must pass bypassCache=true');
  modal.close();
});

test('batchInsertImages returns detailed counts and rejects if all images fail', async () => {
  const h = createHarness();
  const mockFile = new h.TFile('BatchFailNote.md');
  const mockVault = {
    getAbstractFileByPath: (p) => p === 'BatchFailNote.md' ? mockFile : null,
    createFolder: async () => {}
  };
  const mockEditor = {
    lineCount: () => 5,
    getLine: () => '## Title',
    getValue: () => '## Title',
    getCursor: () => ({ line: 0, ch: 0 }),
    replaceRange: () => {}
  };
  const mockView = { file: mockFile, editor: mockEditor };
  const mockContext = { view: mockView, file: mockFile, editor: mockEditor, path: 'BatchFailNote.md', content: '## Title' };

  const plugin = new h.PluginClass({
    vault: mockVault,
    workspace: { getLeavesOfType: () => [{ view: mockView }] }
  }, {});
  plugin.settings = { attachmentFolder: 'Attachments' };
  plugin.writeQueue = Promise.resolve();
  plugin.downloadImage = async () => { throw new Error('Download 404'); };

  const jobs = [
    {
      suggestionIndex: 0,
      targetLine: 1,
      targetHeading: 'Title',
      targetConcept: 'C1',
      targetQuery: 'q1',
      imageItem: { title: 'T1', imageUrl: 'https://example.com/fail.png', targetContext: mockContext }
    }
  ];

  await assert.rejects(plugin.batchInsertImages(jobs), /Failed to insert any images/);
});

test('SearchCache returns cloned items preventing accidental cache mutation', () => {
  const h = createHarness();
  const cache = new h._test.SearchCache();
  const original = [{ title: 'original title', width: 800 }];
  cache.set('key1', original);

  const retrieved = cache.get('key1');
  assert.equal(retrieved[0].title, 'original title');
  retrieved[0].title = 'MUTATED TITLE';

  const retrievedAgain = cache.get('key1');
  assert.equal(retrievedAgain[0].title, 'original title', 'Cache value must not be mutated by caller');
});

test('decodeHtmlEntities decodes supplementary plane characters above U+FFFF', () => {
  const h = createHarness();
  const decode = h._test.decodeHtmlEntities;
  assert.equal(decode('Medication: &#128138;'), 'Medication: 💊');
  assert.equal(decode('Medication: &#x1F48A;'), 'Medication: 💊');
});

test('DuckDuckGoProvider resets name on subsequent search calls after fallback', async () => {
  const h = createHarness();
  h.setRequestUrl(async () => ({
    status: 200,
    json: {
      query: {
        pages: {
          '1': {
            title: 'File:Anatomy.png',
            imageinfo: [{ url: 'https://upload.wikimedia.org/test.png', thumburl: 'https://upload.wikimedia.org/thumb.png', descriptionurl: 'https://commons.wikimedia.org/wiki/File:Anatomy.png' }]
          }
        }
      }
    },
    text: '{}'
  }));

  const ddg = new h._test.DuckDuckGoProvider();
  assert.equal(ddg.name, 'DuckDuckGo (Free / No Key)');

  await ddg.searchFallback('query');
  assert.equal(ddg.name, 'Wikimedia Commons (DuckDuckGo fallback)');

  ddg.searchPrimary = async () => [{ title: 'result', image: 'https://example.com/img.png' }];
  await ddg.search('test');
  assert.equal(ddg.name, 'DuckDuckGo (Free / No Key)', 'Must reset name back to DuckDuckGo');
});

test('normalizeResults accepts valid base64 data URI images and rejects file URIs', () => {
  const h = createHarness();
  const normalize = h._test.normalizeResults;
  const items = [
    { title: 'Data URI Img', imageUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' },
    { title: 'Local File', imageUrl: 'file:///etc/passwd' }
  ];
  const normalized = normalize(items);
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].title, 'Data URI Img');
  assert.ok(normalized[0].imageUrl.startsWith('data:image/png;base64,'));
});

test('MedicalImageFinderView prevents scroll bleed between search and scan tabs', () => {
  const h = createHarness();
  const plugin = new h.PluginClass({
    vault: {},
    workspace: {
      getLeavesOfType: () => [],
      getActiveViewOfType: () => null
    }
  }, {});
  plugin.settings = { defaultProvider: 'duckduckgo' };
  const view = new h._test.MedicalImageFinderView({ leaf: {} }, plugin);

  view.currentTab = 'scan';
  view.contentEl.scrollTop = 500;

  view.switchToSearchTab();
  assert.equal(view.currentTab, 'search');
  assert.equal(view.contentEl.scrollTop, 0, 'Search tab must start at searchScrollTop (0), not inherit scan tab scroll');

  view.contentEl.scrollTop = 200;

  view.switchToScanTab();
  assert.equal(view.currentTab, 'scan');
  assert.equal(view.contentEl.scrollTop, 500, 'Scan tab must restore scannerScrollTop (500)');
});

test('BatchImageReviewModal retains all candidate images and supports multi-image toggle selection', async () => {
  const h = createHarness();
  const plugin = new h.PluginClass({ vault: {}, workspace: {} }, {});
  plugin.settings = { defaultProvider: 'duckduckgo' };

  const view = {
    scanResults: {
      suggestions: [
        { heading: 'Unit 5', line: 100, visualConcept: 'Calot Triangle', visualType: 'diagram', recommendedQuery: 'calot triangle' }
      ]
    },
    scanContext: null,
    insertedSuggestionIndices: new Set(),
    getEffectiveQuery: (q) => q
  };

  const modal = new h._test.BatchImageReviewModal({}, plugin, view);

  // Return 6 candidate images from provider
  const candidateList = [
    { title: 'Calot 1', imageUrl: 'https://example.com/calot1.png', sourceUrl: 'https://example.com/site1' },
    { title: 'Calot 2', imageUrl: 'https://example.com/calot2.png', sourceUrl: 'https://example.com/site2' },
    { title: 'Calot 3', imageUrl: 'https://example.com/calot3.png', sourceUrl: 'https://example.com/site3' },
    { title: 'Calot 4', imageUrl: 'https://example.com/calot4.png', sourceUrl: 'https://example.com/site4' },
    { title: 'Calot 5', imageUrl: 'https://example.com/calot5.png', sourceUrl: 'https://example.com/site5' },
    { title: 'Calot 6', imageUrl: 'https://example.com/calot6.png', sourceUrl: 'https://example.com/site6' }
  ];

  modal.fetchSingleItem = async (rItem) => {
    rItem.items = candidateList;
    rItem.loading = false;
    rItem.included = true;
    rItem.selectedIndices = [0];
    rItem.selectedIdx = 0;
  };

  await modal.onOpen();

  const r = modal.reviewItems[0];
  // Verify all 6 images are preserved (not sliced to 3)
  assert.equal(r.items.length, 6, 'Must retain all returned images');
  assert.deepEqual(r.selectedIndices, [0], 'First image must be selected by default');
  assert.equal(modal.insertBtn.text, '📥 Insert Selected (1)');

  const card = modal.contentEl.querySelector('#mif-batch-card-0');
  assert.ok(card != null);

  const thumbOptions = card.querySelectorAll('.mif-batch-thumb-option');
  assert.equal(thumbOptions.length, 6, 'Must render all 6 thumbnails');

  // Click thumbnail #2 to add it to selection
  thumbOptions[2].onclick({ stopPropagation: () => {}, detail: 1 });
  assert.deepEqual(r.selectedIndices, [0, 2], 'Both #0 and #2 must now be selected');
  assert.equal(modal.insertBtn.text, '📥 Insert Selected (2)');

  // Click thumbnail #4 to add it to selection
  thumbOptions[4].onclick({ stopPropagation: () => {}, detail: 1 });
  assert.deepEqual(r.selectedIndices, [0, 2, 4], 'Thumbnails #0, #2, and #4 must be selected');
  assert.equal(modal.insertBtn.text, '📥 Insert Selected (3)');

  // Click thumbnail #0 again to toggle it off
  thumbOptions[0].onclick({ stopPropagation: () => {}, detail: 1 });
  assert.deepEqual(r.selectedIndices, [2, 4], 'Thumbnail #0 should be unselected leaving #2 and #4');
  assert.equal(modal.insertBtn.text, '📥 Insert Selected (2)');

  modal.close();
});

test('BatchImageReviewModal double-clicking thumbnail triggers openExternalUrl for source', async () => {
  const h = createHarness();
  const plugin = new h.PluginClass({ vault: {}, workspace: {} }, {});
  plugin.settings = { defaultProvider: 'duckduckgo' };

  const view = {
    scanResults: {
      suggestions: [
        { heading: 'Unit 5', line: 100, visualConcept: 'Calot Triangle', visualType: 'diagram', recommendedQuery: 'calot triangle' }
      ]
    },
    scanContext: null,
    insertedSuggestionIndices: new Set(),
    getEffectiveQuery: (q) => q
  };

  const modal = new h._test.BatchImageReviewModal({}, plugin, view);
  modal.fetchSingleItem = async (rItem) => {
    rItem.items = [
      { title: 'Calot 1', imageUrl: 'https://example.com/calot1.png', sourceUrl: 'https://teachmeanatomy.info/calot' }
    ];
    rItem.loading = false;
    rItem.included = true;
    rItem.selectedIndices = [0];
    rItem.selectedIdx = 0;
  };

  await modal.onOpen();

  const card = modal.contentEl.querySelector('#mif-batch-card-0');
  const thumb = card.querySelector('.mif-batch-thumb-option');
  assert.ok(thumb != null);

  // Simulate double-click
  thumb.ondblclick({ preventDefault: () => {}, stopPropagation: () => {} });

  assert.ok(h.openedUrls.includes('https://teachmeanatomy.info/calot'), 'Double click must invoke electron shell to open source website');
  modal.close();
});

test('batchInsertImages sequentially places multiple images under the same topic in Choice #1 then Choice #2 order', async () => {
  const h = createHarness();
  let currentLines = [
    '# Surgical Notes',
    '',
    '## Calot Triangle',
    'The cystohepatic triangle is bounded by cystic duct, hepatic duct, and liver.',
    '---',
    '## Next Section'
  ];

  const mockFile = new h.TFile('SurgeryNote.md');
  const mockVault = {
    getAbstractFileByPath: (p) => {
      if (p === 'SurgeryNote.md') return mockFile;
      return null;
    },
    createBinary: async () => {},
    readBinary: async () => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    createFolder: async () => {}
  };

  const mockEditor = {
    lineCount: () => currentLines.length,
    getLine: (n) => currentLines[n] || '',
    getValue: () => currentLines.join('\n'),
    getCursor: () => ({ line: 3, ch: 0 }),
    replaceRange: (text, pos) => {
      const idx = pos.line;
      const textLines = text.split('\n');
      currentLines.splice(idx, 0, ...textLines);
    }
  };

  const mockView = { file: mockFile, editor: mockEditor };
  const mockContext = { view: mockView, file: mockFile, editor: mockEditor, path: 'SurgeryNote.md', content: currentLines.join('\n') };

  const plugin = new h.PluginClass({
    vault: mockVault,
    workspace: { getLeavesOfType: () => [{ view: mockView }] }
  }, {});
  plugin.settings = { attachmentFolder: 'Attachments', defaultImageWidth: 800, includeCaption: true };
  plugin.writeQueue = Promise.resolve();
  plugin.downloadImage = async (item) => ({ bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]), ext: 'png' });

  // 2 jobs for the same topic: Choice #1 (subIndex 0) and Choice #2 (subIndex 1)
  const jobs = [
    {
      suggestionIndex: 0,
      subIndex: 0,
      targetLine: 4,
      targetHeading: 'Calot Triangle',
      targetConcept: 'Cystohepatic boundaries',
      targetQuery: 'calot triangle anatomy diagram',
      imageItem: {
        title: 'Calot-Diagram-Choice-1',
        imageUrl: 'https://example.com/calot1.png',
        domain: 'teachmeanatomy.info',
        targetContext: mockContext
      }
    },
    {
      suggestionIndex: 0,
      subIndex: 1,
      targetLine: 4,
      targetHeading: 'Calot Triangle',
      targetConcept: 'Cystohepatic boundaries',
      targetQuery: 'calot triangle anatomy diagram',
      imageItem: {
        title: 'Calot-Photo-Choice-2',
        imageUrl: 'https://example.com/calot2.png',
        domain: 'surgicalatlas.org',
        targetContext: mockContext
      }
    }
  ];

  await plugin.batchInsertImages(jobs);

  const doc = currentLines.join('\n');
  const idx1 = doc.indexOf('Calot-Diagram-Choice-1');
  const idx2 = doc.indexOf('Calot-Photo-Choice-2');

  assert.ok(idx1 !== -1, 'Choice #1 must be inserted');
  assert.ok(idx2 !== -1, 'Choice #2 must be inserted');
  assert.ok(idx1 < idx2, 'Choice #1 must appear before Choice #2 in note');
});

test('ImagePreviewModal double click on preview image opens source in browser', () => {
  const h = createHarness();
  const plugin = new h.PluginClass({ vault: {}, workspace: {} }, {});
  const item = {
    title: 'Preview Image',
    imageUrl: 'https://example.com/preview.png',
    sourceUrl: 'https://radiopaedia.org/cases/test'
  };

  const modal = new h._test.ImagePreviewModal({}, plugin, item, null);
  modal.open();

  const img = modal.contentEl.querySelector('.mif-modal-img');
  assert.ok(img != null);

  // Trigger double-click
  img.ondblclick({ preventDefault: () => {}, stopPropagation: () => {} });

  assert.ok(h.openedUrls.includes('https://radiopaedia.org/cases/test'), 'Double-clicking modal image must open source URL');
  modal.close();
});

test('generateImageMarkdown indents image to match bullet continuation without caption or code blocks', () => {
  const h = createHarness();
  const plugin = new h.PluginClass({ vault: {}, workspace: {} }, {});
  plugin.settings = { includeCaption: false };

  const mockEditor = {
    lines: [
      "- **Translucency (Transillumination):** Demonstrates that a fluid-filled cavity transmits light.",
      "    - Requires a completely darkened room.",
      "    - Place a bright light source on one side and observe the opposite side.",
      "    - _Translucent:_ Clear water, serous exudate, lymph, plasma, or hydrocele fluid."
    ],
    lineCount() { return this.lines.length; },
    getLine(idx) { return this.lines[idx] || ''; }
  };

  const item = {
    title: 'A) Hydrocele marked by a fluctuant painless scrotal swelling. (B) Transillumination',
    domain: 'researchgate.net',
    sourceUrl: 'https://researchgate.net/test'
  };

  // 1. Target line is 4-space bullet (starts with "    - ")
  const md = plugin.generateImageMarkdown(mockEditor, { line: 2, ch: mockEditor.lines[2].length }, 'Attachments/MedicalImages/hydrocele.jpg', 500, false, item);
  
  // Must be indented with 6 spaces (4 spaces + "- " = 6 spaces)
  assert.equal(md, '\n      ![[Attachments/MedicalImages/hydrocele.jpg|500]]');
  assert.ok(!md.includes('Hydrocele marked by'), 'Must not insert caption description text');
  assert.ok(!md.includes('researchgate.net'), 'Must not insert source website text in bullet');
  assert.ok(!md.includes('\t'), 'Must never insert tabs');

  // 2. Target line is top-level bullet (starts with "- ")
  const topMd = plugin.generateImageMarkdown(mockEditor, { line: 0, ch: mockEditor.lines[0].length }, 'Attachments/MedicalImages/trans.jpg', 500, false, item);
  assert.equal(topMd, '\n  ![[Attachments/MedicalImages/trans.jpg|500]]');
  assert.ok(!topMd.includes('Hydrocele marked by'));

  // 3. Second image inserted right below an already indented image
  const editorWithImg = {
    lines: [
      "    - Place a bright light source on one side and observe the opposite side.",
      "      ![[Attachments/MedicalImages/hydrocele.jpg|500]]",
      "    - _Translucent:_ Clear water, serous exudate, lymph, plasma, or hydrocele fluid."
    ],
    lineCount() { return this.lines.length; },
    getLine(idx) { return this.lines[idx] || ''; }
  };
  const secondMd = plugin.generateImageMarkdown(editorWithImg, { line: 1, ch: editorWithImg.lines[1].length }, 'Attachments/MedicalImages/hydrocele2.jpg', 500, false, item);
  assert.equal(secondMd, '\n      ![[Attachments/MedicalImages/hydrocele2.jpg|500]]');
});

test('BrightDataProvider successfully processes live Google Images response envelope with data:image thumbnails', async () => {
  const h = createHarness();
  const provider = new h._test.BrightDataProvider('test-key', 'serp_api1');

  h.setRequestUrl(async (opts) => {
    assert.equal(opts.url, 'https://api.brightdata.com/request');
    const body = JSON.parse(opts.body);
    assert.equal(body.format, 'json');

    return {
      status: 200,
      json: {
        status_code: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          general: { search_engine: 'google', query: 'hydrocele transillumination' },
          images: [
            {
              link: 'https://www.google.com/goto?url=CAESw...',
              original_image: 'https://www.researchgate.net/publication/fig1.tif',
              title: 'ResearchGate',
              source: 'A) Hydrocele marked by a fluctuant painless scrotal swelling. (B) Transillumination | Download Scientific Diagram',
              image: 'data:image/jpeg;base64,/9j/4AAQSkZJRg...',
              rank: 1
            }
          ]
        })
      }
    };
  });

  const results = await provider.search('hydrocele transillumination');
  assert.equal(results.length, 1);
  assert.equal(results[0].title, 'A) Hydrocele marked by a fluctuant painless scrotal swelling. (B) Transillumination | Download Scientific Diagram');
  assert.equal(results[0].imageUrl, 'https://www.researchgate.net/publication/fig1.tif');
  assert.equal(results[0].thumbnailUrl, 'data:image/jpeg;base64,/9j/4AAQSkZJRg...');
  assert.equal(results[0].domain, 'researchgate.net');
});
