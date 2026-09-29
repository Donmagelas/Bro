/** Keep each IM payload below its UTF-8 byte limit without dropping content. */
export function splitText(text: string, maxBytes = 12000): string[] {
  const chunks: string[] = [];
  let chunk = "",
    bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maxBytes && chunk) {
      chunks.push(chunk);
      chunk = "";
      bytes = 0;
    }
    chunk += character;
    bytes += size;
  }
  if (chunk || !chunks.length) chunks.push(chunk);
  return chunks;
}
