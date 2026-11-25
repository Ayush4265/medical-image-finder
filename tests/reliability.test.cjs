const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

class Element {
  constructor(tag = 'div', options = {}) {
    this.tag = tag; this.options = options; this.children = []; this.listeners = {};
    this.value = options.attr?.value || ''; this.text = options.text || ''; this.style = {};
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
  class TFile { constructor(name) { this.path = name; this.basename = name.replace(/\.md$/, ''); this.extension = name.endsWith('.md') ? 'md' : 'png'; } }
  class MarkdownView {}
  class ItemView { constructor(leaf) { this.leaf = leaf; this.contentEl = new Element(); } }
  const electron = { nativeImage: { createFromBuffer: bytes => ({ isEmpty: () => !bytes.length || bytes[0] === 60, toPNG: () => Buffer.from([137,80,78,71,13,10,26,10,1]) }) }, clipboard: { writeImage() {} }, shell: { openExternal() {} } };
  const obsidian = { Plugin: class {}, ItemView, TFile, MarkdownView, Modal: class {}, Notice: class { constructor(text) { notices.push(text); } }, PluginSettingTab: class {}, normalizePath: p => p, requestUrl: request };
  const context = { require: id => id === 'obsidian' ? obsidian : id === 'electron' ? electron : require(id), module: {exports:{}}, Buffer, URL, Blob, setTimeout, clearTimeout, console, ...extra };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8') + '\nmodule.exports._test = { MedicalImageFinderView, GeminiScannerService, DuckDuckGoProvider, WikimediaProvider, GoogleCseProvider, SerpApiProvider, BraveProvider, normalizeSettings, normalizeResults, attachmentPath, imageExtension, safeError };', context);
  const Plugin = context.module.exports;
  const plugin = new Plugin(); plugin.settings = Plugin._test.normalizeSettings({}); plugin.pendingActions = new Map(); plugin.writeQueue = Promise.resolve();
  const files = new Map(); const leaves = [];
  const workspace = { active: null, getActiveViewOfType() { return this.active; }, getLeavesOfType(type) { return leaves.filter(l => type === 'markdown' ? l.view instanceof MarkdownView : !(l.view instanceof MarkdownView)); }, revealLeaf: async () => {} };
  const vault = { getAbstractFileByPath: p => files.get(p), createFolder: async p => { files.set(p, {}); }, createBinary: async (p, bytes) => { const file = new TFile(p); file.bytes = Buffer.from(bytes); files.set(p,file); }, readBinary: async f => f.bytes };
  plugin.app = {workspace,vault};
  function note(name, text = 'First line\nSecond line') {
    const file = new TFile(name); files.set(name,file);
    const view = new MarkdownView(); view.file = file;
    view.editor = { text, cursor: 0, inserts: [], getValue() { return this.text; }, getCursor() { return {line:this.cursor,ch:0}; }, getLine(line) { return this.text.split('\n')[line]; }, lineCount() {return this.text.split('\n').length;}, getSelection() {return 'selected';}, setCursor(pos) {this.cursor=pos.line;}, scrollIntoView() {}, replaceRange(text,pos) {this.inserts.push({text,pos});this.text += text;} };
    view.leaf = {view}; leaves.push(view.leaf); workspace.active = view; plugin.lastMarkdownView = view; return view;
  }
  function sidebar(render = false) { const view = new Plugin._test.MedicalImageFinderView({},plugin); view.app = plugin.app; if (!render) view.render = () => {}; leaves.push({view}); return view; }
  return {Plugin, ...Plugin._test, plugin, workspace, vault, files, leaves, note, sidebar, notices, electron};
}
function deferred() { let resolve,reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; }
const item = {title:'Diagram',imageUrl:'https://example.org/image.png',sourceUrl:'https://example.org/source',domain:'example.org'};
const png = Buffer.from([137,80,78,71,13,10,26,10,1]);
function image() { return {bytes:png,ext:'png',nativeImage:{isEmpty:()=>false}}; }
function response(json) { return {json}; }
function scan(suggestions = []) { return response({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({summary:'Scan',suggestions})}]}}]}); }
const suggestion = {heading:'Test',line:1,visualConcept:'Diagram',visualType:'diagram',recommendedQuery:'anatomy diagram',rationale:'Example'};

test('only newest search owns results and errors', async () => {
  const h=harness();const a=deferred(),b=deferred();let n=0;
  h.plugin.getActiveProvider=()=>({name:'mock',search:()=>[a,b][n++].promise});
  const view=h.sidebar();const first=view.executeSearch('old');const second=view.executeSearch('new');
  b.resolve([item]);await second;a.reject(Error('late error'));await first;
  assert.equal(view.results[0].title,'Diagram');assert.equal(view.currentQuery,'new');assert.equal(view.statusType,'normal');
});
test('closed sidebar ignores pending search completion', async () => {
  const h=harness(),d=deferred();h.plugin.getActiveProvider=()=>({name:'mock',search:()=>d.promise});
  const view=h.sidebar();const pending=view.executeSearch('test');await view.onClose();d.resolve([item]);await pending;assert.equal(view.results.length,0);
});
test('typed query survives filter and tab renders; clear invalidates request', async () => {
  const h=harness(),d=deferred();h.note('A.md');h.plugin.getActiveProvider=()=>({name:'mock',search:()=>d.promise});
  const view=h.sidebar(true);view.render();view.queryInput.value='typed query';view.queryInput.listeners.input();
  view.contentEl.all().find(e=>e.text==='Radiology').onclick();assert.equal(view.queryInput.value,'typed query');
  view.switchToScanTab();view.switchToSearchTab();assert.equal(view.queryInput.value,'typed query');
  view.contentEl.all().find(e=>e.options.attr?.title==='Clear query').onclick();d.resolve([item]);await new Promise(r=>setImmediate(r));
  assert.equal(view.currentQuery,'');assert.equal(view.results.length,0);
});
test('sidebar targeting follows last focused note, never arbitrary leaf order', () => {
  const h=harness();const a=h.note('A.md');h.note('B.md');h.workspace.active=a;h.plugin.getTargetView();h.workspace.active=null;assert.equal(h.plugin.captureTarget().file,a.file);
});
test('insertion freezes file and cursor across focus changes', async () => {
  const h=harness(),d=deferred();const a=h.note('A.md');h.plugin.downloadImage=()=>d.promise;
  const pending=h.plugin.saveAndInsertImage(item);a.editor.cursor=1;const b=h.note('B.md');d.resolve(image());await pending;
  assert.equal(a.editor.inserts.length,1);assert.equal(a.editor.inserts[0].pos.line,0);assert.equal(b.editor.inserts.length,0);
});
test('insertion rejects edits during download before vault write', async () => {
  const h=harness(),d=deferred();const a=h.note('A.md');h.plugin.downloadImage=()=>d.promise;
  const pending=h.plugin.saveAndInsertImage(item);a.editor.text+=' edit';d.resolve(image());await assert.rejects(pending,/changed or closed/);assert.equal(h.files.size,1);
});
test('insertion rejects changed note after attachment write', async () => {
  const h=harness();const a=h.note('A.md');h.plugin.downloadImage=async()=>image();
  const create=h.vault.createBinary;h.vault.createBinary=async(...args)=>{await create(...args);a.editor.text+=' edit';};
  await assert.rejects(h.plugin.saveAndInsertImage(item),/changed or closed/);assert.equal(a.editor.inserts.length,0);
});
test('scanner-origin insertion remains tied to scanned note', async () => {
  const h=harness();const a=h.note('A.md');const context=h.plugin.captureTarget();const b=h.note('B.md');h.plugin.downloadImage=async()=>image();
  await h.plugin.saveAndInsertImage({...item,targetContext:context,targetLine:2});assert.equal(a.editor.inserts[0].pos.line,1);assert.equal(b.editor.inserts.length,0);
  await assert.rejects(h.plugin.saveAndInsertImage({...item,targetContext:context,targetLine:2}),/changed or closed/);
});
test('rescan resets inline state and rejects old quick-find completion', async () => {
  const h=harness(async()=>scan([suggestion]));h.note('A.md');h.plugin.settings.geminiApiKey='test';const view=h.sidebar();
  view.scanResults={suggestions:[suggestion]};view.scanContext=h.plugin.captureTarget();const d=deferred();h.plugin.getActiveProvider=()=>({search:()=>d.promise});
  const quick=view.executeInlineQuickFind(0,'anatomy','diagram');await view.executeNoteScan();d.resolve([item]);await quick;
  assert.equal(view.inlineQuickResults.size,0);assert.equal(view.inlineLoading.size,0);assert.equal(view.scanResults.suggestions.length,1);
});
test('Gemini rejects missing, blocked, malformed and invalid suggestion output', async () => {
  for (const data of [{}, {candidates:[{finishReason:'SAFETY'}]}, {candidates:[{content:{parts:[{text:'{}'}]}}]}, scan([{...suggestion,line:999}]).json, scan([{...suggestion,recommendedQuery:4}]).json]) {
    const h=harness(async()=>response(data));await assert.rejects(new h.GeminiScannerService('test').scanNote('Test','one line'));
  }
});
test('Gemini caps suggestions and describes truncation; headings match submitted content', async () => {
  let request;const h=harness(async r=>{request=r;return scan(Array.from({length:12},()=>suggestion));});
  const result=await new h.GeminiScannerService('test').scanNote('Test','x'.repeat(60000)+'\n# Not submitted',5);
  assert.equal(result.suggestions.length,5);assert.match(result.summary,/60,000/);assert.ok(!request.body.includes('Not submitted'));
});
test('DuckDuckGo falls back on HTTP failure and reports provider', async () => {
  const h=harness(async r=>{if(r.url.includes('duckduckgo'))throw Error('blocked');return response({batchcomplete:''});});
  const provider=new h.DuckDuckGoProvider();assert.equal((await provider.search('anatomy')).length,0);assert.match(provider.name,/fallback/);
});
test('provider API errors and malformed responses are not empty success', async () => {
  for(const data of [{error:{message:'quota exhausted'}},{}]) {
    const h=harness(async()=>response(data));
    await assert.rejects(new h.GoogleCseProvider('key','cx').search('test'));
    await assert.rejects(new h.SerpApiProvider('key').search('test'));
    await assert.rejects(new h.BraveProvider('key').search('test'));
  }
});
test('result validation drops malformed URLs and rejects executable source links', () => {
  const h=harness();const result=h.normalizeResults([null,{imageUrl:'file:///x'}, {...item,sourceUrl:'javascript:alert(1)'}]);
  assert.equal(result.length,1);assert.equal(result[0].sourceUrl,'');
});
test('download falls back after HTML or decoding failure', async () => {
  const requested=[];const h=harness(async r=>{requested.push(r.url);const b=r.url.endsWith('image.png')?Buffer.from('<html>Forbidden</html>'):png;return {arrayBuffer:Uint8Array.from(b).buffer};});
  const result=await h.plugin.downloadImage({...item,thumbnailUrl:'https://example.org/thumb.png'});assert.equal(result.ext,'png');assert.equal(requested.length,2);
  h.electron.nativeImage.createFromBuffer=bytes=>({isEmpty:()=>bytes[0]===1,toPNG:()=>png});h.plugin.decodeViaCanvas=async()=>{throw Error('bad decode');};
});
test('undecodable original tries thumbnail and unknown decoded formats convert to PNG', async () => {
  const h=harness(async r=>({arrayBuffer:Uint8Array.from(r.url.endsWith('image.png')?[1,2]:[2,3]).buffer}));
  h.electron.nativeImage.createFromBuffer=bytes=>({isEmpty:()=>bytes[0]===1,toPNG:()=>png});h.plugin.decodeViaCanvas=async()=>{throw Error('bad decode');};
  const result=await h.plugin.downloadImage({...item,thumbnailUrl:'https://example.org/thumb'});assert.equal(result.ext,'png');assert.deepEqual(result.bytes,png);
});
test('extensions recognize JPEG, PNG, GIF, WebP but not generic RIFF',()=>{
  const h=harness();assert.equal(h.imageExtension(png),'png');assert.equal(h.imageExtension([255,216,255]),'jpg');assert.equal(h.imageExtension(Buffer.from('GIF89a')),'gif');assert.equal(h.imageExtension(Buffer.from('RIFF1234WEBP')),'webp');assert.equal(h.imageExtension(Buffer.from('RIFF1234WAVE')),null);
});
test('canvas rejects null blobs and releases object URLs', async()=>{
  let released=0;
  class TestImage {set src(v){queueMicrotask(()=>this.onload());}naturalWidth=1;naturalHeight=1;}
  const TestURL=class extends URL {};TestURL.createObjectURL=()=> 'blob:test';TestURL.revokeObjectURL=()=>released++;
  const h=harness(undefined,{URL:TestURL,Image:TestImage,document:{createElement:()=>({getContext:()=>({drawImage(){}}),toBlob:cb=>cb(null)})}});
  await assert.rejects(h.plugin.decodeViaCanvas(png),/PNG conversion failed/);assert.equal(released,1);
});
test('settings normalize corrupt values and paths reject traversal or absolute forms',()=>{
  const h=harness();for(const p of ['../x','C:\\x','/x','A/../B','A//B','CON','A|B'])assert.throws(()=>h.attachmentPath(p));
  const settings=h.normalizeSettings({defaultProvider:'wrong',defaultImageWidth:-1,geminiApiKey:7,geminiCustomModels:[null],attachmentFolder:'../bad'});
  assert.equal(settings.defaultProvider,'duckduckgo');assert.equal(settings.defaultImageWidth,500);assert.equal(settings.geminiApiKey,'');assert.equal(settings.geminiCustomModels.length,0);
});
test('folder failures surface and existing files are never overwritten',async()=>{
  const h=harness();h.note('A.md');h.plugin.downloadImage=async()=>image();h.vault.createFolder=async()=>{throw Error('permission denied');};
  await assert.rejects(h.plugin.saveAndInsertImage(item),/permission denied/);
});
test('existing attachment contents are verified and collisions never overwrite',async()=>{
  const h=harness();const a=h.note('A.md');h.plugin.downloadImage=async()=>image();
  await h.plugin.saveAndInsertImage(item);
  const stored=[...h.files.values()].find(f=>f.bytes);stored.bytes=Buffer.from('different content');
  await assert.rejects(h.plugin.saveAndInsertImage(item),/Attachment conflict/);
  assert.equal(stored.bytes.toString(),'different content');assert.equal(a.editor.inserts.length,1);
});
test('matching existing attachment is reused without writing another file',async()=>{
  const h=harness();const a=h.note('A.md');h.plugin.downloadImage=async()=>image();
  await h.plugin.saveAndInsertImage(item);await h.plugin.saveAndInsertImage(item);
  assert.equal([...h.files.values()].filter(f=>f.bytes).length,1);assert.equal(a.editor.inserts.length,2);
});
test('invalid or closed scan targets reject jumps instead of jumping into another note',async()=>{
  const h=harness();const a=h.note('A.md');const view=h.sidebar();view.scanContext=h.plugin.captureTarget();h.note('B.md');
  a.editor.text+=' changed';await view.jumpToLine(2);assert.equal(a.editor.cursor,0);assert.match(h.notices.at(-1),/changed or closed/);
});
test('disabled plugin cannot write clipboard after pending download',async()=>{
  const h=harness(),d=deferred();h.plugin.downloadImage=()=>d.promise;let writes=0;h.electron.clipboard.writeImage=()=>writes++;
  const pending=h.plugin.copyImageToClipboard(item);h.plugin.disposed=true;d.resolve(image());await assert.rejects(pending,/disabled/);assert.equal(writes,0);
});
test('duplicate in-flight saves coalesce and new buttons remain disabled',async()=>{
  const h=harness(),d=deferred();const a=h.note('A.md');let downloads=0;h.plugin.downloadImage=()=>{downloads++;return d.promise;};
  const first=h.plugin.saveAndInsertImage(item);const second=h.plugin.saveAndInsertImage(item);const button={};h.plugin.bindAction(button,item,'insert');assert.equal(button.disabled,true);
  d.resolve(image());await Promise.all([first,second]);assert.equal(downloads,1);assert.equal(a.editor.inserts.length,1);
});
test('simultaneous different images serialize and reject a stale insertion',async()=>{
  const h=harness();const a=h.note('A.md');h.plugin.downloadImage=async()=>image();
  const results=await Promise.allSettled([h.plugin.saveAndInsertImage(item),h.plugin.saveAndInsertImage({...item,imageUrl:'https://example.org/other.png'})]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(a.editor.inserts.length,1);
});
test('captions escape markdown and reject non-HTTP source URLs',async()=>{
  const h=harness();const a=h.note('A.md');h.plugin.downloadImage=async()=>image();
  h.plugin.settings.includeCaption = true;
  await h.plugin.saveAndInsertImage({...item,title:'[unsafe]',sourceUrl:'javascript:alert(1)',domain:'[source]'});
  const text=a.editor.inserts[0].text;assert.ok(!text.includes('javascript:'));assert.ok(text.includes('\\[unsafe\\]'));assert.ok(text.includes('\\[source\\]'));
});
test('request errors redact URLs and API keys',()=>{
  const h=harness();const result=h.safeError(Error('Failed https://example.org?key=secret key=secret2 AIzaSecretValue'));
  assert.ok(!result.includes('secret'));assert.ok(!result.includes('AIza'));
});
