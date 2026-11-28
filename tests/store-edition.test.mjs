import assert from 'node:assert/strict';
import test from 'node:test';

const original = 'https://upload.wikimedia.org/wikipedia/commons/5/52/En-us-hello.ogg';
const loadStore = () => import('../packaging/stores/edition/media.mjs');

test('accepts a Commons original and removes pasted tracking parameters', async () => {
  const { parseCommonsMedia } = await loadStore();
  assert.deepEqual(parseCommonsMedia(`${original}?utm_source=commons.wikimedia.org#player`), {
    url: original,
    filename: 'En-us-hello.ogg',
    extension: 'ogg',
  });
});

test('rejects unsupported origins, page URLs, transformed paths and escaped path components', async () => {
  const { parseCommonsMedia } = await loadStore();
  for (const url of [
    'https://www.youtube.com/watch?v=123',
    'https://r1.googlevideo.com/videoplayback',
    'https://commons.wikimedia.org/wiki/File:En-us-hello.ogg',
    'https://upload.wikimedia.org.example.com/wikipedia/commons/5/52/file.ogg',
    'https://example.com@upload.wikimedia.org/wikipedia/commons/5/52/file.ogg',
    'http://upload.wikimedia.org/wikipedia/commons/5/52/file.ogg',
    'https://upload.wikimedia.org:444/wikipedia/commons/5/52/file.ogg',
    'https://upload.wikimedia.org/wikipedia/commons/transcoded/5/52/file.ogg',
    'https://upload.wikimedia.org/wikipedia/commons/5/52/sub%2Ffile.ogg',
    'https://upload.wikimedia.org/wikipedia/commons/5/52/file.svg',
    'https://upload.wikimedia.org/wikipedia/en/5/52/file.ogg',
  ]) {
    assert.throws(() => parseCommonsMedia(url), { message: 'invalid-url' }, url);
  }
});

test('validated media fetch has no cookies, referrer or external redirect', async () => {
  const { fetchCommonsMedia } = await loadStore();
  const { blob, filename } = await fetchCommonsMedia(original, {
    request: async (url, options) => {
      assert.equal(url, original);
      assert.equal(options.credentials, 'omit');
      assert.equal(options.referrerPolicy, 'no-referrer');
      assert.equal(options.redirect, 'error');
      return new Response('OggS fixture', { headers: { 'content-type': 'application/ogg' } });
    },
  });
  assert.equal(filename, 'En-us-hello.ogg');
  assert.equal(blob.type, 'application/ogg');
  assert.equal(await blob.text(), 'OggS fixture');
});

test('nonmedia, redirects, partial responses and over-limit bodies are never saved', async () => {
  const { fetchCommonsMedia } = await loadStore();
  await assert.rejects(fetchCommonsMedia(original, {
    request: async () => new Response('<html>Error</html>', { headers: { 'content-type': 'text/html' } }),
  }), { message: 'media-type' });
  await assert.rejects(fetchCommonsMedia(original, {
    request: async () => new Response('<html>Error</html>', { headers: { 'content-type': 'application/ogg' } }),
  }), { message: 'media-type' });
  await assert.rejects(fetchCommonsMedia(original, {
    request: async () => Response.redirect('https://www.youtube.com/'),
  }), { message: 'fetch-failed' });
  await assert.rejects(fetchCommonsMedia(original, {
    request: async () => new Response('abc', { status: 206, headers: { 'content-type': 'application/ogg' } }),
  }), { message: 'fetch-failed' });
  for (const headers of [
    { 'content-type': 'application/ogg', 'content-length': '6' },
    { 'content-type': 'application/ogg' },
  ]) {
    await assert.rejects(fetchCommonsMedia(original, {
      request: async () => new Response('abcdef', { headers }),
      maxBytes: 5,
    }), { message: 'too-large' });
  }
});

test('invalid sources fail before a network request is made', async () => {
  const { fetchCommonsMedia } = await loadStore();
  let requested = false;
  await assert.rejects(fetchCommonsMedia('https://www.youtube.com/watch?v=123', {
    request: async () => { requested = true; },
  }), { message: 'invalid-url' });
  assert.equal(requested, false);
});
