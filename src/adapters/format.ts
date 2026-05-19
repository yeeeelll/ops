const TELEGRAM_MAX_LEN = 4096;
const SAFE_CHUNK = 3800;

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function splitMessage(text: string, max = SAFE_CHUNK): string[] {
  if (text.length <= max) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > max) {
    let cut = remaining.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = max;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n+/, '');
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

export function asPlainBlock(text: string): string {
  return `<pre>${escapeHtml(text)}</pre>`;
}

export function trimForEdit(text: string): string {
  if (text.length <= TELEGRAM_MAX_LEN) return text;
  const head = text.slice(0, TELEGRAM_MAX_LEN - 200);
  return `${head}\n\n... (内容过长, 完整结果稍后发送)`;
}
