// Ported verbatim from index.html. Do not rewrite -- the frontend and the
// Worker must resolve driver names identically so feed names match the sheet.

// Driver-name aliases. Keys are lower-case, period-free, no rookie/playoff
// markers -- i.e. the lookup form produced by cleanName below. Values are the
// canonical spelling we want every side (feed, sheet) to converge on. Add
// entries here whenever the feed and sheet disagree on a driver's name.
export const DRIVER_ALIASES: Record<string, string> = {
  'john h nemechek': 'John Hunter Nemechek',
  'ricky stenhouse': 'Ricky Stenhouse Jr',
};

export function cleanName(s: string | null | undefined): string {
  // Strip rookie/playoff markers (* #) and periods, collapse whitespace, then
  // resolve any known alias so the feed and the picks sheet match even when
  // they spell a driver differently.
  const cleaned = (s || '').replace(/[*#.]/g, '').replace(/\s+/g, ' ').trim();
  return DRIVER_ALIASES[cleaned.toLowerCase()] || cleaned;
}
