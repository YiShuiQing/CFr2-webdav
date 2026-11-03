import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticate } from '../.test-dist/src/utils/auth.js';
import { generateHTML } from '../.test-dist/src/utils/templates.js';
import { generatePropfindResponse, make_resource_path, InvalidResourcePathError } from '../.test-dist/src/utils/webdavUtils.js';
import { handleCorsPreflight } from '../.test-dist/src/utils/cors.js';

test('authentication fails closed without strong secrets', () => {
  const request = new Request('https://dav.example/', {headers:{Authorization:'Basic dXNlcjpwYXNz'}});
  assert.equal(authenticate(request, {BUCKET:{}}), false);
  assert.equal(authenticate(request, {USERNAME:'user', PASSWORD:'short', BUCKET:{}}), false);
});
test('HTML escapes filenames and rejects javascript href', () => {
  const html = generateHTML('<script>x</script>', [{name:'<img src=x>',href:'javascript:alert(1)'}]);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img/);
  assert.match(html, /href="#"/);
});
test('PROPFIND XML escapes user data and encodes href', () => {
  const xml = generatePropfindResponse('webdav','dir<&',[{creationdate:'now',displayname:'x</D:href><D:evil/>',getcontentlanguage:undefined,getcontentlength:'1',getcontenttype:'text/html"><D:evil/>',getetag:'a&b',getlastmodified:'now',resourcetype:'',href:'/dir%3C%26/x%3C%2FD%3Ahref%3E%3CD%3Aevil%2F%3E'}]);
  assert.ok(xml.includes('<D:href>/dir%3C%26/x'));
  assert.match(xml,/&lt;\/D:href&gt;/);
  assert.doesNotMatch(xml,/<D:evil\/>/);
});
test('path rejects encoded separators and controls', () => {
  assert.throws(()=>make_resource_path(new Request('https://dav.example/a%2fb')),InvalidResourcePathError);
  assert.throws(()=>make_resource_path(new Request('https://dav.example/a%00b')),InvalidResourcePathError);
});
test('CORS rejects arbitrary origins and allows exact configured origins', () => {
  const bad = new Request('https://dav.example/',{method:'OPTIONS',headers:{Origin:'https://evil.example'}});
  assert.equal(handleCorsPreflight(bad,{})?.status,403);
  const good = new Request('https://dav.example/',{method:'OPTIONS',headers:{Origin:'https://client.example','Access-Control-Request-Method':'PUT','Access-Control-Request-Headers':'authorization'}});
  const response=handleCorsPreflight(good,{CORS_ORIGINS:'https://client.example'});
  assert.equal(response?.status,204);
  assert.equal(response?.headers.get('Access-Control-Allow-Credentials'),null);
});
