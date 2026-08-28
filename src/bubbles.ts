const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const bubblePunctuation = new Set(["，", "。", ",", "."]);

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
  const characters = Array.from(segmenter.segment(normalized), ({ segment }) => segment);
  let current = "";

  const flush = () => {
    const value = current.trim();
    if (value) bubbles.push(...splitLongLine(value, maxCharacters));
    current = "";
  };

  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index] || "";
    if (character === "\n") {
      flush();
      continue;
    }
    current += character;
    if (!bubblePunctuation.has(character)) continue;

    const next = characters[index + 1];
    if (next && bubblePunctuation.has(next)) continue;
    const isChinesePunctuation = character === "，" || character === "。";
    const followedByBoundary = (
      next === undefined
      || next === "\n"
      || /^\s$/u.test(next)
      || /^\p{Script=Han}$/u.test(next)
    );
    if (isChinesePunctuation || followedByBoundary) flush();
  }
  flush();
  return bubbles;
}
