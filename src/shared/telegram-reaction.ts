export function parseTelegramReactionType(input: string): string {
  const normalized = input.trim().normalize('NFC');
  const graphemes = [
    ...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(normalized),
  ];
  if (
    graphemes.length !== 1 ||
    normalized.length > 32 ||
    !/\p{Extended_Pictographic}/u.test(normalized)
  ) {
    throw new Error('Reaction type must be one valid emoji');
  }
  return normalized;
}

export function normalizeTelegramReactionType(reactionType: string): string {
  return parseTelegramReactionType(reactionType).replaceAll('\uFE0F', '');
}
