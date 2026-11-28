import { fetchCommonsMedia } from './media.mjs';

const input = document.getElementById('url');
const prepare = document.getElementById('prepare');
const save = document.getElementById('save');
const status = document.getElementById('status');

const chinese = navigator.language.toLowerCase().startsWith('zh');
const messages = chinese ? {
  loading: '正在读取文件…',
  ready: filename => `${filename} 已准备就绪。`,
  'invalid-url': '请使用 Wikimedia Commons 的原始 WebM 或 Ogg 文件链接。',
  'too-large': '文件超过 100 MiB。',
  'media-type': '响应并非受支持的 WebM 或 Ogg 文件。',
  'fetch-failed': '无法读取该原始文件。请检查链接和网络连接。',
} : {
  loading: 'Reading the file…',
  ready: filename => `${filename} is ready to save.`,
  'invalid-url': 'Enter a Wikimedia Commons original WebM or Ogg file URL.',
  'too-large': 'The file exceeds 100 MiB.',
  'media-type': 'The response is not a supported WebM or Ogg file.',
  'fetch-failed': 'The original file could not be read. Check the URL and connection.',
};

if (chinese) {
  document.documentElement.lang = 'zh-CN';
  for (const [id, text] of Object.entries({
    intro: '保存你有权下载的 Wikimedia Commons 原始音频或视频文件。',
    'url-label': '原始文件链接',
    formats: '支持不超过 100 MiB 的 WebM 和 Ogg 文件。',
    prepare: '读取文件',
    save: '保存文件',
  })) document.getElementById(id).textContent = text;
}

function releasePreparedFile() {
  if (save.hasAttribute('href')) URL.revokeObjectURL(save.href);
  save.removeAttribute('href');
  save.hidden = true;
  status.textContent = '';
}

input.addEventListener('input', releasePreparedFile);
document.querySelector('form').addEventListener('submit', async event => {
  event.preventDefault();
  if (prepare.disabled) return;
  releasePreparedFile();
  prepare.disabled = true;
  input.readOnly = true;
  status.textContent = messages.loading;
  try {
    const { blob, filename } = await fetchCommonsMedia(input.value, { signal: AbortSignal.timeout(120_000) });
    save.download = filename;
    save.href = URL.createObjectURL(blob);
    save.hidden = false;
    status.textContent = messages.ready(filename);
  } catch (error) {
    status.textContent = messages[error.message] ?? messages['fetch-failed'];
  } finally {
    prepare.disabled = false;
    input.readOnly = false;
  }
});
