// NASCAR CDN fetch helpers. cf.nascar.com answers bare/datacenter requests with
// 403 (see nascar-feeds.md S6/S10), so send browser-like headers. Note: Worker
// egress is itself datacenter traffic -- if these 403 from the Worker, fall
// back to running the schedule/archive fetch from a residential IP and POSTing
// via the operator routes. This is the main NASCAR-side risk (see README).
const HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Referer: 'https://www.nascar.com/',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
};

// Full-season schedule for all three series, keyed series_1/2/3.
export async function fetchScheduleJson(year: number): Promise<any> {
  const url = `https://cf.nascar.com/cacher/${year}/race_list_basic.json`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`schedule HTTP ${res.status}`);
  return res.json();
}

// Raw lap-times.json bytes for a race (archive target). The series-namespaced
// cacher/live path persists post-race (verified in nascar-feeds.md); the
// year-namespaced cacher path is a durable fallback. Returns NASCAR's exact
// payload so R2 holds a byte-faithful archive.
export async function fetchLapTimes(
  year: number,
  seriesId: number,
  raceId: number,
): Promise<ArrayBuffer> {
  const urls = [
    `https://cf.nascar.com/cacher/live/series_${seriesId}/${raceId}/lap-times.json`,
    `https://cf.nascar.com/cacher/${year}/${seriesId}/${raceId}/lap-times.json`,
  ];
  let lastStatus = 0;
  for (const url of urls) {
    const res = await fetch(url, { headers: HEADERS });
    if (res.ok) return res.arrayBuffer();
    lastStatus = res.status;
  }
  throw new Error(`lap-times HTTP ${lastStatus}`);
}
