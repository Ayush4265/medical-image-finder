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

function createHarness() {
  const notices = [];
  let clipboardText = '';
  let harnessRequestUrl = async (opts) => ({ status: 200, json: {}, text: '{}' });
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

  const electron = {
    nativeImage: {
      createFromBuffer: bytes => ({
        isEmpty: () => !bytes.length || bytes[0] === 60,
        toPNG: () => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1])
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
          Setting: class {
            constructor(container) { this.container = container; }
            setName() { return this; }
            setDesc() { return this; }
            addDropdown(cb) {
              cb({
                addOption: () => this,
                setValue: () => this,
                onChange: () => this
              });
              return this;
            }
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
  vm.runInContext(code + '\nmodule.exports._test = { GeminiScannerService, MedicalImageFinderView, DuckDuckGoProvider, BraveProvider, SerpApiProvider, BrightDataProvider, BatchImageReviewModal };', sandbox);

  return {
    PluginClass: sandbox.module.exports,
    GeminiScannerService: sandbox.module.exports._test.GeminiScannerService,
    _test: sandbox.module.exports._test,
    setRequestUrl: (fn) => { harnessRequestUrl = fn; },
    TFile,
    notices
  };
}

test('buildAltGPrompt incorporates custom target image counts (15, 30, 40)', () => {
  const h = createHarness();
  const noteTitle = 'Pancreas Surgery';
  const noteContent = '## Whipple\nLine 1\nLine 2';

  const prompt15 = h.GeminiScannerService.buildAltGPrompt(noteTitle, noteContent, 15);
  assert.ok(prompt15.includes('Provide at most 15 high-yield suggestions'), 'Must specify 15 suggestions in prompt rules');
  assert.ok(prompt15.includes('Select the 15 most high-yield concepts'), 'Must specify 15 suggestions in prompt selection');

  const prompt40 = h.GeminiScannerService.buildAltGPrompt(noteTitle, noteContent, 40);
  assert.ok(prompt40.includes('Provide at most 40 high-yield suggestions'), 'Must specify 40 suggestions in prompt rules');
  assert.ok(prompt40.includes('Select the 40 most high-yield concepts'), 'Must specify 40 suggestions in prompt selection');
});

test('findTopicInsertionPosition places image directly under specific bullet point matching concept keywords', () => {
  const h = createHarness();
  const plugin = new h.PluginClass({ vault: {}, workspace: {} }, {});

  const lines = [
    '# Pancreatic Pathology',
    '## Congenital Anomalies',
    '- **Pancreas Divisum**: Failure of ventral and dorsal pancreatic bud fusion.',
    '- **Annular Pancreas**: Pancreatic tissue encircling the second part of duodenum.',
    '    - Causes neonatal duodenal obstruction.',
    '    - Characterized by the classic "double-bubble" sign on plain radiograph.',
    '- **Ectopic Pancreas**: Heterotopic pancreatic rests in gastric or jejunal submucosa.',
    '---',
    '## Next Section'
  ];

  const mockEditor = {
    lineCount: () => lines.length,
    getLine: (i) => lines[i] || '',
    getCursor: () => ({ line: 0, ch: 0 })
  };

  // 1. Target "double-bubble" sign in Annular Pancreas (concept keywords: double bubble sign)
  const posBubble = plugin.findTopicInsertionPosition(
    mockEditor,
    4,
    'Congenital Anomalies',
    'Annular Pancreas Double-Bubble Sign Radiograph',
    'double bubble sign X-ray'
  );

  assert.equal(posBubble.line, 5, 'Must insert immediately after the double-bubble bullet line');
  assert.equal(lines[posBubble.line].trim(), '- Characterized by the classic "double-bubble" sign on plain radiograph.');

  // 2. Target "Pancreas Divisum"
  const posDivisum = plugin.findTopicInsertionPosition(
    mockEditor,
    2,
    'Congenital Anomalies',
    'Pancreas Divisum Bud Rotation Anomaly',
    'pancreas divisum ventral dorsal fusion diagram'
  );
  assert.equal(posDivisum.line, 2, 'Must insert immediately after Pancreas Divisum bullet, before Annular Pancreas');
  assert.equal(lines[posDivisum.line].trim(), '- **Pancreas Divisum**: Failure of ventral and dorsal pancreatic bud fusion.');
});

test('batchInsertImages places multiple images from bottom to top with zero line drift', async () => {
  const h = createHarness();
  const mockFile = new h.TFile('TestNote.md');
  const writtenFiles = new Map();

  const mockVault = {
    getAbstractFileByPath: (p) => {
      if (p === 'TestNote.md') return mockFile;
      return writtenFiles.has(p) ? { path: p } : null;
    },
    createBinary: async (p, buf) => { writtenFiles.set(p, buf); },
    readBinary: async (p) => writtenFiles.get(p.path || p),
    createFolder: async () => {}
  };

  const initialLines = [
    '# Chapter 1',
    '## Anatomy',
    '- **Point A**: First anatomical detail.',
    '- **Point B**: Second anatomical detail with sign.',
    '- **Point C**: Third anatomical detail.',
    '## Summary'
  ];

  let currentLines = [...initialLines];
  const mockEditor = {
    lineCount: () => currentLines.length,
    getLine: (i) => currentLines[i] || '',
    getValue: () => currentLines.join('\n'),
    getCursor: () => ({ line: 0, ch: 0 }),
    replaceRange: (str, pos) => {
      const targetLine = pos.line;
      const lineStr = currentLines[targetLine] || '';
      const before = currentLines.slice(0, targetLine);
      const atLine = lineStr.slice(0, pos.ch) + str + lineStr.slice(pos.ch);
      const after = currentLines.slice(targetLine + 1);
      currentLines = [...before, ...atLine.split('\n'), ...after];
    }
  };

  const mockView = { file: mockFile, editor: mockEditor };
  const mockContext = { view: mockView, file: mockFile, editor: mockEditor, path: 'TestNote.md', content: mockEditor.getValue() };

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

  plugin.downloadImage = async (item) => ({
    bytes: Buffer.from('fake-image-bytes'),
    ext: 'png',
    nativeImage: { toPNG: () => Buffer.from('fake-png') }
  });

  const jobs = [
    {
      suggestionIndex: 0,
      targetLine: 3,
      targetHeading: 'Anatomy',
      targetConcept: 'Point A detail diagram',
      targetQuery: 'Point A diagram',
      imageItem: {
        title: 'Image A',
        imageUrl: 'https://example.com/a.png',
        domain: 'example.com',
        targetContext: mockContext
      }
    },
    {
      suggestionIndex: 1,
      targetLine: 4,
      targetHeading: 'Anatomy',
      targetConcept: 'Point B sign',
      targetQuery: 'Point B sign',
      imageItem: {
        title: 'Image B',
        imageUrl: 'https://example.com/b.png',
        domain: 'example.com',
        targetContext: mockContext
      }
    }
  ];

  await plugin.batchInsertImages(jobs);

  const finalLines = currentLines;

  // Verify that Point A image block is right under Point A
  const idxEmbedA = finalLines.findIndex(l => l.includes('![[Attachments/Image-A-'));
  assert.ok(idxEmbedA !== -1, 'Image A embed must be inserted');
  const lineAboveA = finalLines.slice(0, idxEmbedA).filter(l => l.trim()).pop();
  assert.ok(lineAboveA.includes('Point A'), `Image A embed must be directly below Point A, found: "${lineAboveA}"`);

  // Verify that Point B image block is right under Point B
  const idxEmbedB = finalLines.findIndex(l => l.includes('![[Attachments/Image-B-'));
  assert.ok(idxEmbedB !== -1, 'Image B embed must be inserted');
  const lineAboveB = finalLines.slice(0, idxEmbedB).filter(l => l.trim()).pop();
  assert.ok(lineAboveB.includes('Point B'), `Image B embed must be directly below Point B, found: "${lineAboveB}"`);

  // Verify Point A came before Point B in the final note
  assert.ok(idxEmbedA < idxEmbedB, 'Image A must appear before Image B in the document');
});

test('persistent memory restores lastScanResults across view re-renders and settings', async () => {
  const h = createHarness();
  const savedScan = {
    summary: 'Previous audit of Pancreas',
    suggestions: [
      { heading: 'Anatomy', line: 10, visualConcept: 'Portal Vein Confluence', visualType: 'diagram', rationale: 'Viva spotter', recommendedQuery: 'portal vein diagram' }
    ]
  };

  const plugin = new h.PluginClass({ vault: {}, workspace: { getLeavesOfType: () => [], getActiveViewOfType: () => null } }, {});
  plugin.settings = {
    defaultProvider: 'duckduckgo',
    lastScanResults: savedScan,
    lastImportedGeminiResponse: 'raw json string',
    lastScannedNote: 'Pancreas.md'
  };
  plugin.saveSettings = async () => {};

  const view = new h._test.MedicalImageFinderView({ leaf: {} }, plugin);
  assert.ok(view.scanResults != null, 'View must initialize scanResults from settings.lastScanResults');
  assert.equal(view.scanResults.summary, 'Previous audit of Pancreas');
  assert.equal(view.restoredFromMemory, true);

  // Clear memory
  await view.clearScanMemory();
  assert.equal(view.scanResults, null);
  assert.equal(plugin.settings.lastScanResults, null);
  assert.equal(plugin.settings.lastImportedGeminiResponse, '');
});

test('getProvider returns corresponding search provider instance with fallback to DuckDuckGo', () => {
  const h = createHarness();
  const plugin = new h.PluginClass({ vault: {}, workspace: {} }, {});
  plugin.settings = { defaultProvider: 'duckduckgo', braveApiKey: 'brave-key-123', brightDataApiKey: 'bd-key-123' };

  const ddg = plugin.getProvider('duckduckgo');
  assert.ok(ddg instanceof h._test.DuckDuckGoProvider);

  const brave = plugin.getProvider('brave');
  assert.ok(brave instanceof h._test.BraveProvider);

  const bd = plugin.getProvider('brightdata');
  assert.ok(bd instanceof h._test.BrightDataProvider);

  const fallback = plugin.getProvider('unknown');
  assert.ok(fallback instanceof h._test.DuckDuckGoProvider);
});

test('BatchImageReviewModal renders Retry, Try SerpApi, and Try Bright Data on error cards', async () => {
  const h = createHarness();
  const plugin = new h.PluginClass({ vault: {}, workspace: {} }, {});
  plugin.settings = { defaultProvider: 'duckduckgo', serpApiKey: '', brightDataApiKey: '' };
  
  const view = {
    scanResults: {
      suggestions: [
        { heading: 'Unit 5', line: 356, visualConcept: 'Galactography filling defect', visualType: 'radiology', recommendedQuery: 'galactography intraductal papilloma' }
      ]
    },
    scanContext: null,
    insertedSuggestionIndices: new Set(),
    getEffectiveQuery: (q) => q
  };

  const modal = new h._test.BatchImageReviewModal({}, plugin, view);
  modal.onOpen();

  // Simulate error response for card 0
  const rItem = modal.reviewItems[0];
  rItem.loading = false;
  rItem.error = 'No images returned by DuckDuckGo. Try different keywords or switch engine.';
  rItem.items = [];

  modal.updateCard(rItem);

  // Check footer insert button text
  assert.equal(modal.insertBtn.text, '📥 Insert Selected (0)');

  // Find card retry button
  const card = modal.contentEl.querySelector('#mif-batch-card-0');
  assert.ok(card != null, 'Card must exist');
  
  const retryBtn = card.querySelector('.mif-batch-card-retry');
  assert.ok(retryBtn != null, 'Retry button must exist on card');
  assert.equal(retryBtn.text, '🔄 Retry', 'Retry button must have text 🔄 Retry, never Insert Selected');
  assert.ok(!retryBtn.hasClass('mif-btn-insert'), 'Retry button must NOT have mif-btn-insert class');

  // Check Try SerpApi and Try Bright Data buttons
  const altButtons = card.querySelectorAll('.mif-batch-card-alt');
  const serpBtn = altButtons.find(b => b.text === 'Try SerpApi');
  assert.ok(serpBtn != null, 'Card must have Try SerpApi button');
  const bdBtn = altButtons.find(b => b.text === 'Try Bright Data');
  assert.ok(bdBtn != null, 'Card must have Try Bright Data button');

  // Clicking Try SerpApi without key triggers a Notice
  await serpBtn.onclick();
  assert.ok(h.notices.some(n => n.includes('SerpApi API Key is missing')), 'Must notify when SerpApi key is missing');

  // Clicking Try Bright Data without key triggers a Notice
  await bdBtn.onclick();
  assert.ok(h.notices.some(n => n.includes('Bright Data API Key is missing')), 'Must notify when Bright Data key is missing');
});

test('BrightDataProvider searches via SERP API and normalizes image results', async () => {
  const h = createHarness();
  const provider = new h._test.BrightDataProvider('test-token-123', 'serp_api1');

  h.setRequestUrl(async (opts) => {
    assert.equal(opts.url, 'https://api.brightdata.com/request');
    assert.equal(opts.method, 'POST');
    assert.equal(opts.headers.Authorization, 'Bearer test-token-123');
    const parsedBody = JSON.parse(opts.body);
    assert.equal(parsedBody.zone, 'serp_api1');
    assert.equal(parsedBody.format, 'json');
    assert.ok(parsedBody.url.includes('pancreas%20whipple'));

    return {
      status: 200,
      json: {
        images: [
          {
            title: 'Whipple Procedure Reconstruction',
            image: 'https://encrypted-tbn0.gstatic.com/images?q=thumb',
            original_image: 'https://example.com/whipple_highres.jpg',
            link: 'https://example.com/surgery/whipple',
            original_width: 1200,
            original_height: 800
          }
        ]
      },
      text: ''
    };
  });

  const results = await provider.search('pancreas whipple');
  assert.equal(results.length, 1);
  assert.equal(results[0].title, 'Whipple Procedure Reconstruction');
  assert.equal(results[0].imageUrl, 'https://example.com/whipple_highres.jpg');
  assert.equal(results[0].thumbnailUrl, 'https://encrypted-tbn0.gstatic.com/images?q=thumb');
  assert.equal(results[0].domain, 'example.com');
  assert.equal(results[0].width, 1200);
  assert.equal(results[0].height, 800);
});

test('BrightDataProvider unwraps status_code/headers/body envelope format gracefully', async () => {
  const h = createHarness();
  const provider = new h._test.BrightDataProvider('test-token-123', 'serp_api1');

  h.setRequestUrl(async (opts) => {
    return {
      status: 200,
      json: {
        status_code: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          general: { search_engine: 'google' },
          images: [
            {
              title: 'Wikipedia',
              source: 'Triangle of Doom - Wikipedia',
              image: 'data:image/jpeg;base64,9j4AAQSkZJRg==',
              original_image: 'https://upload.wikimedia.org/wikipedia/commons/e/e4/Gray824.png',
              link: 'https://www.google.com/goto?url=CAESawHEIkXX'
            }
          ]
        })
      },
      text: ''
    };
  });

  const results = await provider.search('triangle of doom');
  assert.equal(results.length, 1);
  assert.equal(results[0].title, 'Triangle of Doom - Wikipedia');
  assert.equal(results[0].imageUrl, 'https://upload.wikimedia.org/wikipedia/commons/e/e4/Gray824.png');
  assert.equal(results[0].thumbnailUrl, 'data:image/jpeg;base64,9j4AAQSkZJRg==');
  assert.equal(results[0].domain, 'upload.wikimedia.org');
});

test('BrightDataProvider falls back to dataset scraper API if SERP zone errors', async () => {
  const h = createHarness();
  const provider = new h._test.BrightDataProvider('test-token-123', 'serp_api1');

  let callCount = 0;
  h.setRequestUrl(async (opts) => {
    callCount++;
    if (opts.url === 'https://api.brightdata.com/request') {
      throw new Error('SERP zone not configured');
    }
    if (opts.url.includes('datasets/v3/scrape')) {
      return {
        status: 200,
        json: [
          {
            title: 'Dataset Whipple Fallback',
            image_url: 'https://example.org/dataset_whipple.jpg',
            url: 'https://example.org/study'
          }
        ],
        text: ''
      };
    }
    throw new Error('Unexpected URL: ' + opts.url);
  });

  const results = await provider.search('pancreas whipple fallback');
  assert.equal(results.length, 1);
  assert.equal(results[0].title, 'Dataset Whipple Fallback');
  assert.equal(results[0].imageUrl, 'https://example.org/dataset_whipple.jpg');
  assert.equal(results[0].domain, 'example.org');
});


