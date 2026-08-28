const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function splitLongLine(line: string, maxCharacters: number): string[] {
  const chunks: string[] = [];
  let current = "";
  let count = 0;

  for (const { segment } of segmenter.segment(line)) {
    if (count >= maxCharacters) {
      chunks.push(current);
      current = "";
      count = 0;
    }
    current += segment;
    count += 1;
  }
  if (current) chunks.push(current);
  return chunks;
}

export function splitBubbles(text: string, maxCharacters = 3000): string[] {
  const normalized = String(text ?? "").replace(/\r\n?/g, "\n");
  const bubbles: string[] = [];

  for (const line of normalized.split("\n")) {
    if (!line.trim()) continue;
    bubbles.push(...splitLongLine(line, maxCharacters));
  }
  return bubbles;
}
