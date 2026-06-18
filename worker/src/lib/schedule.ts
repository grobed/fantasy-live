// Derive a race's green-flag start instant from a race_list_basic entry.
// Ported from index.html's raceStartDate(), but returns an ISO-8601 UTC string
// for storage instead of a Date. Central-time *display* formatting stays in the
// frontend; the Worker stores only the canonical UTC instant.
//
// Prefer the schedule[] entry's start_time_utc (the only explicitly-UTC field;
// race_date carries no timezone), falling back to race_date.
export function raceStartUtc(race: any): string | null {
  const timed = (race.schedule || []).filter((e: any) => e && e.start_time_utc);
  const looksRace = (e: any) => {
    const s = `${e.run_type || ''} ${e.event_name || ''}`.toLowerCase();
    return /race/.test(s) && !/practice|qual/.test(s);
  };
  const toUtc = (s: string) =>
    new Date(/[zZ]$|[+-]\d\d:?\d\d$/.test(s) ? s : s + 'Z');
  const byTime = (a: any, b: any) =>
    toUtc(a.start_time_utc).getTime() - toUtc(b.start_time_utc).getTime();
  // The points race is the weekend's last timed event; prefer one labelled
  // "race", otherwise just take the last.
  const labelled = timed.filter(looksRace).sort(byTime);
  const pick = labelled.length ? labelled[labelled.length - 1]
    : (timed.slice().sort(byTime).pop() || null);
  if (pick) {
    const d = toUtc(pick.start_time_utc);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  if (race.race_date) {
    const d = new Date(race.race_date);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}
