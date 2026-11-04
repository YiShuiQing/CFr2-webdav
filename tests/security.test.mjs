import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticate } from '../.test-dist/src/utils/auth.js';
import { generateHTML } from '../.test-dist/src/utils/templates.js';
import { generatePropfindResponse, make_resource_path, InvalidResourcePathError, listAll } from '../.test-dist/src/utils/webdavUtils.js';
import { handleCorsPreflight } from '../.test-dist/src/utils/cors.js';
import { handleWebDAV } from '../.test-dist/src/handlers/webdavHandler.js';

test('authentication fails closed without strong secrets', () => {
  const request = new Request('https://dav.example/', {headers:{Authorization:'Basic dXNlcjpwYXNz'}});
  assert.equal(authenticate(request, {BUCKET:{}}), false);
  assert.equal(authenticate(request, {USERNAME:'user', PASSWORD:'short', BUCKET:{}}), false);
  const valid = new Request('https://dav.example/', {headers:{Authorization:'Basic '+btoa('user:12345678901234567890')}});
  assert.equal(authenticate(valid, {USERNAME:'user', PASSWORD:'12345678901234567890', BUCKET:{}}), true);
});
test('HTML escapes filenames and rejects javascript href', () => {
  const html = generateHTML('<script>x</script>', [{name:'<img src=x>',href:'javascript:alert(1)'}]);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img/);
  assert.match(html, /href="#"/);
});
test('PROPFIND XML escapes untrusted values and emits an encoded href', () => {
  const xml = generatePropfindResponse('webdav','dir<&',[{creationdate:'now',displayname:'x</D:href><D:evil/>',getcontentlanguage:undefined,getcontentlength:'1',getcontenttype:'text/html"><D:evil/>',getetag:'a&b',getlastmodified:'now',resourcetype:'',href:'/dir%3C%26/x%3C%2FD%3Ahref%3E%3CD%3Aevil%2F%3E'}]);
  assert.ok(xml.includes('<D:href>/dir%3C%26/x'));
  assert.match(xml,/&lt;\/D:href&gt;/);
  assert.doesNotMatch(xml,/<D:evil\/>/);
});
test('path rejects encoded separators, controls and dot segments', () => {
  assert.throws(()=>make_resource_path(new Request('https://dav.example/a%2fb')),InvalidResourcePathError);
  assert.throws(()=>make_resource_path(new Request('https://dav.example/a%00b')),InvalidResourcePathError);
  const normalized = make_resource_path(new Request('https://dav.example/a/%2e%2e/secret'));
  assert.equal(normalized.includes('..'), false);
});
test('CORS rejects arbitrary origins and allows exact configured origins', () => {
  const bad = new Request('https://dav.example/',{method:'OPTIONS',headers:{Origin:'https://evil.example'}});
  assert.equal(handleCorsPreflight(bad,{})?.status,403);
  const good = new Request('https://dav.example/',{method:'OPTIONS',headers:{Origin:'https://client.example','Access-Control-Request-Method':'PUT','Access-Control-Request-Headers':'authorization'}});
  const response=handleCorsPreflight(good,{CORS_ORIGINS:'https://client.example'});
  assert.equal(response?.status,204);
  assert.equal(response?.headers.get('Access-Control-Allow-Credentials'),null);
});

function makeObject(key, customMetadata = {}) {
  return {
    key, size: 1, etag: 'etag', httpEtag: '"etag"',
    uploaded: new Date('2026-01-01T00:00:00Z'),
    httpMetadata: { contentType: 'text/plain' }, customMetadata,
    body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.close(); } }),
  };
}
function mockBucket(overrides = {}) {
  const calls = [];
  return {
    calls,
    head: async (key) => overrides.head ? overrides.head(key) : null,
    get: async (key, options) => overrides.get ? overrides.get(key, options) : null,
    put: async (key, value, options) => {
      calls.push({method:'put', key, options});
      return overrides.put ? overrides.put(key, value, options) : makeObject(key);
    },
    delete: async (key) => { calls.push({method:'delete', key}); },
    list: async (options) => overrides.list ? overrides.list(options) : ({objects:[],delimitedPrefixes:[],truncated:false}),
  };
}
const envFor = (bucket) => ({ BUCKET: bucket, BUCKET_NAME: 'webdav' });

test('OPTIONS advertises DAV Class 1 only and does not claim MOVE support', async () => {
  const response = await handleWebDAV(new Request('https://dav.example/', {method:'OPTIONS'}), envFor(mockBucket()));
  assert.equal(response.headers.get('DAV'), null);
  assert.doesNotMatch(response.headers.get('Allow') || '', /MOVE|LOCK|UNLOCK/);
});
test('PROPFIND rejects Depth infinity instead of silently returning a shallow listing', async () => {
  const bucket = mockBucket();
  const response = await handleWebDAV(new Request('https://dav.example/', {method:'PROPFIND',headers:{Depth:'infinity'}}), envFor(bucket));
  assert.equal(response.status, 403);
  assert.equal(bucket.calls.length, 0);
});
test('MKCOL refuses to create a collection without its parent', async () => {
  const bucket = mockBucket();
  const response = await handleWebDAV(new Request('https://dav.example/a/b/', {method:'MKCOL'}), envFor(bucket));
  assert.equal(response.status, 409);
  assert.equal(bucket.calls.filter(x=>x.method==='put').length, 0);
});
test('MKCOL creates only if the marker does not already exist', async () => {
  const bucket = mockBucket();
  const response = await handleWebDAV(new Request('https://dav.example/new-dir/', {method:'MKCOL'}), envFor(bucket));
  assert.equal(response.status, 201);
  const put = bucket.calls.find(x=>x.method==='put');
  assert.equal(put.key, 'new-dir/');
  assert.equal(put.options.onlyIf.get('If-None-Match'), '*');
});
test('PUT forwards HTTP preconditions to atomic R2 write and returns 412 on failure', async () => {
  const bucket = mockBucket({put: async () => null});
  const response = await handleWebDAV(new Request('https://dav.example/file.txt', {method:'PUT',headers:{'If-None-Match':'*','Content-Length':'4'},body:'data'}), envFor(bucket));
  assert.equal(response.status, 412);
  const put = bucket.calls.find(x=>x.method==='put');
  assert.equal(put.options.onlyIf.get('If-None-Match'), '*');
});
test('PUT passes the original known-length request stream to R2 without wrapping it', async () => {
  const request = new Request('https://dav.example/upload.txt', {
    method: 'PUT',
    headers: { 'Content-Length': '4', 'Content-Type': 'text/plain' },
    body: 'data',
  });
  const originalBody = request.body;
  let receivedBody;
  const bucket = mockBucket({
    put: async (_key, value) => {
      receivedBody = value;
      return makeObject('upload.txt');
    },
  });
  const response = await handleWebDAV(request, envFor(bucket));
  assert.equal(response.status, 201);
  assert.equal(receivedBody, originalBody);
});
test('PUT rejects unknown-length streams with 411 before calling R2', async () => {
  const request = new Request('https://dav.example/upload.txt', {
    method: 'PUT',
    body: 'data',
  });
  assert.equal(request.headers.get('Content-Length'), null);
  const bucket = mockBucket();
  const response = await handleWebDAV(request, envFor(bucket));
  assert.equal(response.status, 411);
  assert.equal(bucket.calls.length, 0);
});
test('PUT rejects oversized uploads from Content-Length before calling R2', async () => {
  const request = new Request('https://dav.example/large.bin', {
    method: 'PUT',
    headers: { 'Content-Length': '101' },
    body: 'x'.repeat(101),
  });
  const bucket = mockBucket();
  const response = await handleWebDAV(request, { ...envFor(bucket), MAX_UPLOAD_BYTES: '100' });
  assert.equal(response.status, 413);
  assert.equal(bucket.calls.length, 0);
});
test('COPY Overwrite F uses an atomic no-overwrite condition', async () => {
  const source = makeObject('source.txt');
  const bucket = mockBucket({
    get: async () => source,
    put: async () => null,
  });
  const response = await handleWebDAV(new Request('https://dav.example/source.txt', {method:'COPY',headers:{Destination:'https://dav.example/target.txt',Overwrite:'F'}}), envFor(bucket));
  assert.equal(response.status, 412);
  const put = bucket.calls.find(x=>x.method==='put');
  assert.equal(put.options.onlyIf.get('If-None-Match'), '*');
});
test('MOVE is explicitly disabled and does not alter R2 objects', async () => {
  const bucket = mockBucket();
  const response = await handleWebDAV(new Request('https://dav.example/source.txt', {method:'MOVE',headers:{Destination:'https://dav.example/target.txt'}}), envFor(bucket));
  assert.equal(response.status, 501);
  assert.equal(bucket.calls.length, 0);
});
test('DELETE refuses collection markers instead of deleting only the marker', async () => {
  const bucket = mockBucket({head: async () => makeObject('folder/', {resourcetype:'collection'})});
  const response = await handleWebDAV(new Request('https://dav.example/folder/', {method:'DELETE'}), envFor(bucket));
  assert.equal(response.status, 501);
  assert.equal(bucket.calls.length, 0);
});
test('DELETE returns 404 for missing objects', async () => {
  const bucket = mockBucket();
  const response = await handleWebDAV(new Request('https://dav.example/missing.txt', {method:'DELETE'}), envFor(bucket));
  assert.equal(response.status, 404);
  assert.equal(bucket.calls.length, 0);
});
test('conditional DELETE is rejected rather than silently ignoring If-Match', async () => {
  const bucket = mockBucket({head: async () => makeObject('file.txt')});
  const response = await handleWebDAV(new Request('https://dav.example/file.txt', {method:'DELETE',headers:{'If-Match':'"etag"'}}), envFor(bucket));
  assert.equal(response.status, 501);
  assert.equal(bucket.calls.length, 0);
});

test('R2 directory listing requests custom metadata and de-duplicates prefixes', async () => {
  let receivedOptions;
  const marker = makeObject('folder/', {resourcetype:'collection'});
  const bucket = {
    list: async (options) => {
      receivedOptions = options;
      return {objects:[marker],delimitedPrefixes:['folder/'],truncated:false};
    },
  };
  const entries = [];
  for await (const entry of listAll(bucket, '', 10)) entries.push(entry);
  assert.deepEqual(receivedOptions.include, ['httpMetadata', 'customMetadata']);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].key, 'folder/');
  assert.equal(entries[0].isDirectory, true);
  assert.ok(entries[0].object);
});
test('PROPFIND returns quoted HTTP ETag for WebDAV getetag property', async () => {
  const bucket = mockBucket({head: async () => makeObject('file.txt')});
  const response = await handleWebDAV(new Request('https://dav.example/file.txt', {method:'PROPFIND',headers:{Depth:'0'}}), envFor(bucket));
  assert.equal(response.status, 207);
  const xml = await response.text();
  assert.match(xml, /<D:getetag>&quot;etag&quot;<\/D:getetag>/);
});
test('DELETE detects an implicit collection and refuses partial deletion', async () => {
  const bucket = mockBucket({
    head: async () => null,
    list: async () => ({objects:[makeObject('folder/file.txt')],delimitedPrefixes:[],truncated:false}),
  });
  const response = await handleWebDAV(new Request('https://dav.example/folder', {method:'DELETE'}), envFor(bucket));
  assert.equal(response.status, 501);
  assert.equal(bucket.calls.length, 0);
});

test('legacy directory marker without custom metadata is classified as a collection', async () => {
  const marker = makeObject('legacy-folder/');
  const bucket = {
    list: async () => ({
      objects: [marker],
      delimitedPrefixes: [],
      truncated: false,
    }),
  };
  const entries = [];
  for await (const entry of listAll(bucket, '', 10)) entries.push(entry);
  assert.equal(entries[0].isDirectory, true);
  assert.deepEqual(entries[0].object.customMetadata, {});
});
test('PROPFIND recognizes legacy marker objects and exposes their child files', async () => {
  const marker = makeObject('legacy-folder/');
  const child = makeObject('legacy-folder/file.txt');
  const bucket = mockBucket({
    head: async (key) => key === 'legacy-folder/' ? marker : null,
    list: async (options) => options.prefix === 'legacy-folder/'
      ? ({objects:[marker,child],delimitedPrefixes:[],truncated:false})
      : ({objects:[],delimitedPrefixes:[],truncated:false}),
  });
  const response = await handleWebDAV(new Request('https://dav.example/legacy-folder/', {method:'PROPFIND',headers:{Depth:'1'}}), envFor(bucket));
  assert.equal(response.status, 207);
  const xml = await response.text();
  assert.match(xml, /<D:href>\/legacy-folder\/<\/D:href>/);
  assert.match(xml, /<D:href>\/legacy-folder\/file.txt<\/D:href>/);
  assert.match(xml, /<D:resourcetype><D:collection\/><\/D:resourcetype>/);
});
test('PROPFIND resolves implicit collection requested without trailing slash', async () => {
  const child = makeObject('implicit-folder/file.txt');
  const bucket = mockBucket({
    head: async () => null,
    list: async (options) => options.prefix === 'implicit-folder/'
      ? ({objects:[child],delimitedPrefixes:[],truncated:false})
      : ({objects:[],delimitedPrefixes:[],truncated:false}),
  });
  const response = await handleWebDAV(new Request('https://dav.example/implicit-folder', {method:'PROPFIND',headers:{Depth:'1'}}), envFor(bucket));
  assert.equal(response.status, 207);
  const xml = await response.text();
  assert.match(xml, /<D:href>\/implicit-folder\/<\/D:href>/);
  assert.match(xml, /implicit-folder\/file.txt/);
});
