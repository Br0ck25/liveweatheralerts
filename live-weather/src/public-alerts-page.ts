type AlertState = 'ACTIVE_ALERTS' | 'NO_ALERTS';
type AlertKind = 'warning' | 'watch' | 'advisory' | 'statement' | 'other';

const STATE_CODES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
  'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
  'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY',
];

const PRIORITY: Array<{ pattern: RegExp; score: number }> = [
  { pattern: /tornado warning/i, score: 1000 },
  { pattern: /flash flood warning/i, score: 940 },
  { pattern: /hurricane warning/i, score: 900 },
  { pattern: /blizzard warning/i, score: 880 },
  { pattern: /severe thunderstorm warning/i, score: 860 },
  { pattern: /tornado watch/i, score: 790 },
  { pattern: /flash flood watch/i, score: 770 },
  { pattern: /severe thunderstorm watch/i, score: 760 },
  { pattern: /winter weather advisory/i, score: 680 },
  { pattern: /wind advisory/i, score: 650 },
  { pattern: /heat advisory/i, score: 630 },
  { pattern: /flood advisory/i, score: 610 },
  { pattern: /special weather statement/i, score: 560 },
];

export interface PublicPageUtils {
  classifyAlert: (event: string) => 'warning' | 'watch' | 'other';
  severityBadgeColor: (severity: string) => string;
  formatDateTime: (value: string) => string;
  formatAlertDescription: (raw: string) => string;
  formatLastSynced: (iso: string) => string;
  safeHtml: (text: string) => string;
  nl2br: (text: string) => string;
  extractStateCode: (feature: any) => string;
  stateCodeToName: (code: string) => string;
}

interface AlertRow {
  id: string;
  stateCode: string;
  event: string;
  severity: string;
  urgency: string;
  certainty: string;
  areaDesc: string;
  headline: string;
  description: string;
  instruction: string;
  sent: string;
  expires: string;
  updated: string;
  nwsUrl: string;
}

const ts = (v: string): number => {
  const n = new Date(String(v || '')).getTime();
  return Number.isFinite(n) ? n : 0;
};

const kind = (event: string): AlertKind => {
  if (/warning/i.test(event)) return 'warning';
  if (/watch/i.test(event)) return 'watch';
  if (/advisory/i.test(event)) return 'advisory';
  if (/statement/i.test(event)) return 'statement';
  return 'other';
};

const theme = (k: AlertKind): string => (k === 'warning' ? 'warn' : k === 'watch' ? 'watch' : k === 'advisory' ? 'adv' : k === 'statement' ? 'stmt' : 'other');

const eventScore = (event: string): number => {
  for (const rule of PRIORITY) if (rule.pattern.test(event)) return rule.score;
  const k = kind(event);
  return k === 'warning' ? 740 : k === 'watch' ? 640 : k === 'advisory' ? 560 : k === 'statement' ? 500 : 450;
};

const score = (a: AlertRow): number => {
  const sev = String(a.severity || '').toLowerCase();
  const urg = String(a.urgency || '').toLowerCase();
  const cert = String(a.certainty || '').toLowerCase();
  const sevScore = sev === 'extreme' ? 130 : sev === 'severe' ? 100 : sev === 'moderate' ? 70 : sev === 'minor' ? 35 : 20;
  const urgScore = urg === 'immediate' ? 60 : urg === 'expected' ? 35 : urg === 'future' ? 20 : urg === 'past' ? 0 : 10;
  const certScore = cert === 'observed' ? 50 : cert === 'likely' ? 35 : cert === 'possible' ? 20 : cert === 'unlikely' ? 5 : 10;
  const recent = Math.max(ts(a.sent), ts(a.updated));
  const mins = recent ? Math.max(0, Math.round((Date.now() - recent) / 60000)) : 999999;
  const rec = mins <= 15 ? 35 : mins <= 60 ? 25 : mins <= 180 ? 15 : mins <= 720 ? 8 : 2;
  return eventScore(a.event) + sevScore + urgScore + certScore + rec;
};

const shortArea = (v: string, max = 42): string => {
  const s = String(v || 'Your area').replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : `${s.slice(0, max - 1)}...`;
};

const bullets = (a: AlertRow): string[] => {
  const merged = [a.headline, a.description, a.instruction].filter(Boolean).join('\n');
  const labeled = merged.match(/(?:HAZARD|IMPACT|WHAT|IMPACTS):\s*[^\n.]+/gi)?.map((x) => x.replace(/^[A-Z]+:\s*/i, '').trim()) || [];
  if (labeled.length) return labeled.slice(0, 3);
  const lines = merged.split(/\n+/).map((x) => x.trim()).filter((x) => x.length > 18 && x.length < 120);
  return (lines.length ? lines : ['Conditions may become dangerous quickly.', 'Monitor updates and act early.']).slice(0, 3);
};

const cta = (event: string): string => {
  const e = String(event || '').toLowerCase();
  if (e.includes('tornado warning')) return 'Take Shelter Now';
  if (e.includes('flash flood warning')) return 'Move to Higher Ground';
  if (e.includes('severe thunderstorm warning')) return 'Stay Alert';
  if (e.includes('blizzard warning') || e.includes('winter storm warning')) return 'Avoid Travel';
  if (e.includes('heat advisory')) return 'Limit Outdoor Activity';
  return 'View Alert Details';
};

const until = (expires: string): string => {
  const m = ts(expires);
  if (!m) return 'Unknown expiration';
  const mins = Math.round((m - Date.now()) / 60000);
  if (mins <= 0) return 'Expiring now';
  if (mins < 60) return `Until ${mins}m from now`;
  const h = Math.floor(mins / 60);
  const r = mins % 60;
  return r === 0 ? `Until ${h}h from now` : `Until ${h}h ${r}m from now`;
};

const stateName = (code: string, map: (code: string) => string): string => String(map(code) || code)
  .replace(/-/g, ' ')
  .split(/\s+/)
  .filter(Boolean)
  .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
  .join(' ');

const safeJson = (v: unknown): string => JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');

export function renderPublicAlertsPage(alerts: any[], lastPoll: string | undefined, syncError: string | undefined, utils: PublicPageUtils): string {
  const rows: AlertRow[] = alerts.map((f) => {
    const p = f?.properties ?? {};
    return {
      id: String(f?.id ?? p.id ?? ''),
      stateCode: String(utils.extractStateCode(f) || '').toUpperCase(),
      event: String(p.event ?? 'Weather Alert'),
      severity: String(p.severity ?? ''),
      urgency: String(p.urgency ?? ''),
      certainty: String(p.certainty ?? ''),
      areaDesc: String(p.areaDesc ?? ''),
      headline: String(p.headline ?? '').trim(),
      description: utils.formatAlertDescription(String(p.description ?? '')),
      instruction: utils.formatAlertDescription(String(p.instruction ?? '')),
      sent: String(p.sent ?? p.effective ?? ''),
      expires: String(p.expires ?? ''),
      updated: String(p.updated ?? ''),
      nwsUrl: String(p['@id'] ?? ''),
    };
  });

  const sorted = [...rows].sort((a, b) => score(b) - score(a) || ts(b.updated || b.sent) - ts(a.updated || a.sent));
  const alertState: AlertState = sorted.length ? 'ACTIVE_ALERTS' : 'NO_ALERTS';
  const primary = sorted[0];
  const secondary = sorted.slice(1, 4);
  const headlines = sorted.slice(0, 24);
  const lastSynced = lastPoll ? utils.formatLastSynced(lastPoll) : 'Waiting for first sync';
  const warningCount = sorted.filter((a) => kind(a.event) === 'warning').length;
  const watchCount = sorted.filter((a) => kind(a.event) === 'watch').length;
  const advisoryCount = sorted.filter((a) => kind(a.event) === 'advisory').length;

  const states = new Set<string>(STATE_CODES);
  for (const a of sorted) if (a.stateCode) states.add(a.stateCode);
  const stateOptions = Array.from(states)
    .sort((a, b) => stateName(a, utils.stateCodeToName).localeCompare(stateName(b, utils.stateCodeToName)))
    .map((code) => `<option value="${utils.safeHtml(code)}">${utils.safeHtml(stateName(code, utils.stateCodeToName))}</option>`)
    .join('');

  const hero = primary
    ? `<article class="hero ${theme(kind(primary.event))}"><p class="ey">Highest Priority Alert</p><h2>${utils.safeHtml(primary.event)}</h2><p class="ar">${utils.safeHtml(shortArea(primary.areaDesc))}</p><p class="mt">${utils.safeHtml(primary.severity || 'Unknown')} · ${utils.safeHtml(primary.urgency || 'Monitoring')}</p><p class="sb">What this means</p><ul>${bullets(primary).map((x) => `<li>${utils.safeHtml(x)}</li>`).join('')}</ul><div class="ac"><button class="btn p" type="button">${utils.safeHtml(cta(primary.event))}</button><a class="btn s" href="${utils.safeHtml(/^https?:\/\//i.test(primary.nwsUrl) ? primary.nwsUrl : '#alerts')}" target="_blank" rel="noopener noreferrer">View Details</a></div><p class="tm">Expires: ${utils.safeHtml(primary.expires ? utils.formatDateTime(primary.expires) : 'Unknown')} · Updated: ${utils.safeHtml((primary.updated || primary.sent) ? utils.formatDateTime(primary.updated || primary.sent) : 'Unknown')}</p><p class="tm">${utils.safeHtml(until(primary.expires))}</p></article>`
    : `<article class="hero clear"><p class="ey">All Clear</p><h2>No active weather alerts</h2><p class="sb">What to Watch</p><ul><li>Keep notifications on.</li><li>Review your safety plan.</li><li>Check radar before travel.</li></ul><p class="tm">Last updated: ${utils.safeHtml(lastSynced)}</p></article>`;

  const mini = secondary.length
    ? secondary.map((a) => `<article class="mini ${theme(kind(a.event))}"><p class="ev">${utils.safeHtml(a.event)}</p><p class="ar">${utils.safeHtml(shortArea(a.areaDesc, 26))}</p><p class="tm">${utils.safeHtml(until(a.expires))}</p></article>`).join('')
    : '<div class="empty">No additional active alerts for this area.</div>';

  const rowList = (items: AlertRow[]) => items.length
    ? items.map((a) => `<a class="row ${theme(kind(a.event))}" href="${utils.safeHtml(/^https?:\/\//i.test(a.nwsUrl) ? a.nwsUrl : '#')}" target="_blank" rel="noopener noreferrer"><div><p class="ev">${utils.safeHtml(a.event)}</p><p class="cp">${utils.safeHtml((bullets(a)[0] || 'Tap for details.'))}</p></div><p class="ar">${utils.safeHtml(shortArea(a.areaDesc, 24))}</p></a>`).join('')
    : '<div class="empty">No active alerts right now.</div>';

  const data = safeJson(sorted);

  const css = `
*{box-sizing:border-box}html,body{margin:0;padding:0}body{min-height:100vh;font-family:"Barlow Condensed","Segoe UI",sans-serif;color:#f4f8ff;background:radial-gradient(circle at 20% 0%,rgba(88,152,255,.45),rgba(88,152,255,0) 40%),linear-gradient(180deg,#04122f,#0b2f66)}
.app{width:min(100%,430px);margin:0 auto;min-height:100vh;padding-bottom:92px}.top{position:sticky;top:0;z-index:12;display:flex;justify-content:space-between;align-items:center;padding:14px 12px;border-bottom:1px solid rgba(255,255,255,.14);background:rgba(4,16,40,.92);backdrop-filter:blur(10px)}
.b{display:flex;gap:8px;align-items:center}.bi{width:28px;height:28px;border-radius:8px;background:linear-gradient(145deg,#ff4f56,#d20f26);display:grid;place-items:center;font-weight:800}.b h1{margin:0;font-family:"Anton","Impact",sans-serif;font-size:1.42rem;letter-spacing:.03em;text-transform:uppercase}.tl{display:flex;gap:8px}.tbn{width:34px;height:34px;border-radius:10px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:#fff}
.sc{display:none;padding:12px 10px 0}.sc.on{display:block}.st{display:flex;gap:8px;align-items:center;margin-bottom:10px}.loc{flex:1;border:1px solid rgba(255,255,255,.14);border-radius:12px;padding:8px 10px;background:rgba(0,0,0,.22);color:#b7cae9}.chip{border-radius:999px;padding:6px 10px;font-size:.84rem;text-transform:uppercase;letter-spacing:.05em;border:1px solid rgba(255,255,255,.14)}.chip.a{background:rgba(255,72,72,.2);color:#ffd6d6}.chip.c{background:rgba(63,151,255,.24);color:#d6ebff}
.hero{border-radius:18px;border:1px solid rgba(255,255,255,.16);padding:14px;margin-bottom:12px;box-shadow:0 18px 35px rgba(0,0,0,.35)}.hero h2{margin:10px 0 0;font-family:"Anton","Impact",sans-serif;line-height:.95;text-transform:uppercase;font-size:clamp(1.7rem,8vw,2.2rem)}.hero .ey{margin:0;font-size:.78rem;text-transform:uppercase;letter-spacing:.08em;font-weight:700}.hero .ar{margin:8px 0 0;font-size:1.15rem;font-weight:700}.hero .mt{margin:4px 0 0;text-transform:uppercase;font-size:.88rem}.hero .sb{margin:10px 0 6px;text-transform:uppercase;letter-spacing:.06em}.hero ul{margin:0;padding-left:18px;display:grid;gap:4px}.hero .tm{margin:8px 0 0;font-size:.86rem}
.ac{margin-top:10px;display:grid;grid-template-columns:1fr 1fr;gap:8px}.btn{min-height:42px;border-radius:11px;border:1px solid rgba(255,255,255,.2);font-family:inherit;font-weight:700;text-transform:uppercase;letter-spacing:.04em;display:grid;place-items:center}.btn.p{background:rgba(0,0,0,.24);color:#fff}.btn.s{background:rgba(20,95,220,.86);color:#f4fbff}
.warn{background:linear-gradient(145deg,#ff4343,#be111f)}.watch{background:linear-gradient(145deg,#ffbc56,#e06a24)}.adv{background:linear-gradient(145deg,#ffd288,#e28d3f)}.stmt{background:linear-gradient(145deg,#3da6ff,#1f6fd9)}.other{background:linear-gradient(145deg,#4f9fff,#2872d6)}.clear{background:linear-gradient(145deg,#2686ff,#45b7ff)}
.pn{border:1px solid rgba(255,255,255,.14);background:rgba(6,17,42,.9);border-radius:14px;margin-bottom:12px;overflow:hidden}.hd{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:10px 11px;border-bottom:1px solid rgba(255,255,255,.09)}.hd h3{margin:0;font-family:"Anton","Impact",sans-serif;text-transform:uppercase;letter-spacing:.03em}.hd p{margin:0;color:#b7cae9}
.mr{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(170px,1fr);gap:8px;overflow-x:auto;padding:10px}.mini{border-radius:12px;border:1px solid rgba(255,255,255,.2);padding:10px}.mini .ev{margin:0;text-transform:uppercase;font-weight:800;line-height:1.03}.mini .ar{margin:8px 0 0}.mini .tm{margin:8px 0 0;font-size:.85rem;text-transform:uppercase}
.cc{display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:10px}.tb{border-radius:12px;border:1px solid rgba(255,255,255,.14);padding:12px;background:linear-gradient(155deg,rgba(39,130,255,.45),rgba(8,32,74,.9))}.tb .v{margin:4px 0 0;font-family:"Anton","Impact",sans-serif;font-size:3rem;line-height:.95}.sl{border-radius:12px;border:1px solid rgba(255,255,255,.14);padding:12px;background:rgba(4,14,35,.86);display:grid;gap:7px}.sl p{margin:0;display:flex;justify-content:space-between}
.hr{display:grid;grid-auto-flow:column;grid-auto-columns:72px;gap:8px;overflow-x:auto;padding:10px}.h{border-radius:12px;border:1px solid rgba(255,255,255,.14);text-align:center;background:linear-gradient(170deg,rgba(35,90,172,.74),rgba(6,18,44,.92));padding:8px 6px}.h p{margin:0;font-weight:700}.h span{display:block;margin-top:4px;color:#c6ddff}
.rd{position:relative;min-height:132px;border-radius:12px;border:1px solid rgba(255,255,255,.14);margin:10px;background:radial-gradient(circle at 24% 22%,rgba(255,194,61,.75),rgba(255,194,61,0) 35%),radial-gradient(circle at 54% 45%,rgba(255,91,76,.8),rgba(255,91,76,0) 36%),radial-gradient(circle at 70% 60%,rgba(119,221,102,.67),rgba(119,221,102,0) 40%),linear-gradient(140deg,#102340,#1f456f)}.rd .ov{position:absolute;left:10px;right:10px;bottom:10px;display:flex;justify-content:space-between;gap:8px}
.rw{display:grid;gap:8px;padding:10px}.row{border-radius:12px;border:1px solid rgba(255,255,255,.2);padding:10px;display:flex;justify-content:space-between;gap:8px;align-items:center}.row .ev{margin:0;text-transform:uppercase;font-weight:900;line-height:1}.row .cp{margin:6px 0 0;font-size:.92rem}.row .ar{margin:0;text-align:right;min-width:80px}.empty{border:1px dashed rgba(255,255,255,.2);border-radius:12px;padding:12px;color:#d4e5ff}
.bn{border-radius:12px;border:1px solid rgba(255,255,255,.14);padding:10px;margin-bottom:12px}.bn.a{background:linear-gradient(145deg,rgba(255,84,84,.31),rgba(140,24,24,.46))}.bn.c{background:linear-gradient(145deg,rgba(61,149,255,.31),rgba(31,89,209,.46))}.bn h3{margin:0;font-family:"Anton","Impact",sans-serif;text-transform:uppercase;letter-spacing:.04em}.bn p{margin:6px 0 0}
.mo{display:grid;gap:9px;padding:10px}.fd{display:grid;gap:6px}.fd label{font-size:.85rem;color:#c4d7f4;text-transform:uppercase;letter-spacing:.06em}.fd select{min-height:42px;border-radius:10px;border:1px solid rgba(255,255,255,.14);background:rgba(7,17,41,.92);color:#fff;font-family:inherit;font-size:1rem;padding:0 10px}.mo button{min-height:42px;border-radius:10px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.08);color:#fff;font-family:inherit}.ft{color:#a8c0e2;text-align:center;font-size:.86rem}
.nv{position:fixed;left:50%;transform:translateX(-50%);bottom:0;width:min(100%,430px);display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:4px;padding:8px 8px 11px;border-top:1px solid rgba(255,255,255,.14);border-radius:18px 18px 0 0;background:rgba(2,9,23,.78);backdrop-filter:blur(14px)}.tab{position:relative;min-height:56px;border:0;border-radius:12px;background:transparent;color:#d6e7ff;font-family:inherit;display:grid;place-items:center;gap:1px;transition:transform .16s ease,background .16s ease}.tab .lb{font-size:.82rem;font-weight:700}.tab.on{background:linear-gradient(160deg,rgba(34,124,255,.92),rgba(17,73,178,.88));color:#fff;box-shadow:0 8px 20px rgba(18,95,247,.42);transform:translateY(-2px)}.bd{position:absolute;top:6px;right:16px;min-width:18px;height:18px;border-radius:999px;background:#ff2d2d;color:#fff;font-size:.72rem;font-weight:900;display:none;align-items:center;justify-content:center}.bd.on{display:inline-flex}
.gt{position:fixed;inset:0;z-index:40;background:rgba(0,0,0,.62);backdrop-filter:blur(8px);display:flex;align-items:flex-end;justify-content:center;padding:12px}.gt.h{display:none}.gp{width:min(100%,420px);border-radius:24px;border:1px solid rgba(255,255,255,.14);background:linear-gradient(165deg,rgba(5,18,44,.98),rgba(9,30,70,.94));padding:16px 14px}.gp p{margin:0;color:#c6daf8}.gp h2{margin:7px 0 0;font-family:"Anton","Impact",sans-serif;text-transform:uppercase;line-height:1.02}.ga{margin-top:14px;display:grid;gap:8px}.ga button{min-height:46px;border-radius:12px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.08);color:#fff;font-family:inherit;font-size:1rem;font-weight:700}.ga .p{background:linear-gradient(160deg,rgba(40,147,255,.96),rgba(27,94,208,.92))}.zf{margin-top:10px;display:none;gap:8px}.zf.on{display:grid}.zf input{min-height:44px;border-radius:10px;border:1px solid rgba(255,255,255,.14);background:rgba(7,18,42,.95);color:#fff;padding:0 12px;font-family:inherit;font-size:1rem}.zf button{min-height:44px;border-radius:10px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.09);color:#fff;font-family:inherit}.ge{margin-top:8px;min-height:18px;color:#ffb7b7}
.sw{border:1px solid rgba(250,188,95,.42);border-radius:10px;background:rgba(173,109,0,.22);color:#ffe3b6;padding:8px 10px;margin-bottom:10px}
`;

  const script = `
const DATA=${data},STATE_KEY='liveWeather:selectedState',LOC_KEY='liveWeather:userLocation';
const q=(s)=>document.querySelector(s),qa=(s)=>Array.from(document.querySelectorAll(s));
const hero=q('#hero'),mini=q('#mini'),topRows=q('#topRows'),allRows=q('#allRows'),chip=q('#chip'),locLbl=q('#locLbl'),badge=q('#badge'),fcBanner=q('#fcBanner'),rdBanner=q('#rdBanner'),stateSel=q('#stateFilter'),stateSum=q('#stateSum');
const gate=q('#gate'),allowBtn=q('#allowBtn'),zipBtn=q('#zipBtn'),zipForm=q('#zipForm'),zipInput=q('#zipInput'),zipSubmit=q('#zipSubmit'),gateErr=q('#gateErr'),resetBtn=q('#resetBtn');
const esc=(v)=>String(v||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;').replace(/'/g,'&#39;');
const t=(v)=>{const n=new Date(String(v||'')).getTime();return Number.isFinite(n)?n:0;};
const k=(e)=>/warning/i.test(e||'')?'warning':/watch/i.test(e||'')?'watch':/advisory/i.test(e||'')?'advisory':/statement/i.test(e||'')?'statement':'other';
const th=(x)=>x==='warning'?'warn':x==='watch'?'watch':x==='advisory'?'adv':x==='statement'?'stmt':'other';
const ev=(e)=>{const r=[[/tornado warning/i,1000],[/flash flood warning/i,940],[/hurricane warning/i,900],[/blizzard warning/i,880],[/severe thunderstorm warning/i,860],[/tornado watch/i,790],[/flash flood watch/i,770],[/severe thunderstorm watch/i,760],[/winter weather advisory/i,680],[/wind advisory/i,650],[/heat advisory/i,630],[/flood advisory/i,610],[/special weather statement/i,560]];for(const [re,s] of r){if(re.test(e||''))return s;}const kk=k(e);return kk==='warning'?740:kk==='watch'?640:kk==='advisory'?560:kk==='statement'?500:450;};
const sev=(s)=>{s=String(s||'').toLowerCase();return s==='extreme'?130:s==='severe'?100:s==='moderate'?70:s==='minor'?35:20;};
const urg=(s)=>{s=String(s||'').toLowerCase();return s==='immediate'?60:s==='expected'?35:s==='future'?20:s==='past'?0:10;};
const cert=(s)=>{s=String(s||'').toLowerCase();return s==='observed'?50:s==='likely'?35:s==='possible'?20:s==='unlikely'?5:10;};
const age=(a,b)=>{const m=Math.max(t(a),t(b));if(!m)return 0;const d=Math.max(0,Math.round((Date.now()-m)/60000));return d<=15?35:d<=60?25:d<=180?15:d<=720?8:2;};
const srt=(a,b)=>(ev(b.event)+sev(b.severity)+urg(b.urgency)+cert(b.certainty)+age(b.sent,b.updated))-(ev(a.event)+sev(a.severity)+urg(a.urgency)+cert(a.certainty)+age(a.sent,a.updated))||t(b.updated||b.sent)-t(a.updated||a.sent);
const sh=(v,m=42)=>{v=String(v||'Your area').replace(/\s+/g,' ').trim();return v.length<=m?v:v.slice(0,m-1)+'...';};
const bl=(a)=>{const m=[a.headline,a.description,a.instruction].filter(Boolean).join('\n');const l=(m.match(/(?:HAZARD|IMPACT|WHAT|IMPACTS):\s*[^\n.]+/gi)||[]).map(x=>x.replace(/^[A-Z]+:\s*/i,'').trim());if(l.length)return l.slice(0,3);const p=m.split(/\n+/).map(x=>x.trim()).filter(x=>x.length>18&&x.length<120);return (p.length?p:['Conditions may become dangerous quickly.','Monitor updates and act early.']).slice(0,3);};
const act=(e)=>{e=String(e||'').toLowerCase();if(e.includes('tornado warning'))return'Take Shelter Now';if(e.includes('flash flood warning'))return'Move to Higher Ground';if(e.includes('severe thunderstorm warning'))return'Stay Alert';if(e.includes('blizzard warning')||e.includes('winter storm warning'))return'Avoid Travel';if(e.includes('heat advisory'))return'Limit Outdoor Activity';return'View Alert Details';};
const fmt=(v)=>{const d=new Date(String(v||''));if(Number.isNaN(d.getTime()))return'Unknown';return d.toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});};
const ul=(v)=>{const m=t(v);if(!m)return'Unknown expiration';const n=Math.round((m-Date.now())/60000);if(n<=0)return'Expiring now';if(n<60)return'Until '+n+'m from now';const h=Math.floor(n/60),r=n%60;return r===0?'Until '+h+'h from now':'Until '+h+'h '+r+'m from now';};
const getLoc=()=>{try{const j=JSON.parse(localStorage.getItem(LOC_KEY)||'null');if(!j)return null;const lat=Number(j.lat),lon=Number(j.lon);if(!Number.isFinite(lat)||!Number.isFinite(lon))return null;return {...j,state:j.state?String(j.state).toUpperCase():undefined};}catch{return null;}};
const setLoc=(v)=>{try{localStorage.setItem(LOC_KEY,JSON.stringify(v));}catch{}};const clrLoc=()=>{try{localStorage.removeItem(LOC_KEY);}catch{}};
const getState=()=>{try{const s=String(localStorage.getItem(STATE_KEY)||'').toUpperCase();return !s||s==='ALL'?'all':s;}catch{return'all';}};
const setState=(v)=>{try{localStorage.setItem(STATE_KEY,v||'all');}catch{}};
let loc=getLoc(),sel=getState();
const eff=()=>sel&&sel!=='all'?sel:(loc?.state?String(loc.state).toUpperCase():'all');
const scoped=()=>{const s=eff();return s==='all'?DATA.slice():DATA.filter(a=>String(a.stateCode||'').toUpperCase()===s);};
const st=(c)=>{if(!stateSel)return c;const o=Array.from(stateSel.options).find(x=>x.value===c);return o&&o.textContent?o.textContent:c;};
const hHero=(a,title)=>{if(!a)return'<article class="hero clear"><p class="ey">All Clear</p><h2>No active weather alerts</h2><p class="sb">What to Watch</p><ul><li>Keep notifications on.</li><li>Review your safety plan.</li><li>Check radar before travel.</li></ul></article>';const b=bl(a).map(x=>'<li>'+esc(x)+'</li>').join(''),href=/^https?:\/\//i.test(a.nwsUrl||'')?a.nwsUrl:'#alerts';return'<article class="hero '+th(k(a.event))+'"><p class="ey">Highest Priority Alert</p><h2>'+esc(a.event||'Weather Alert')+'</h2><p class="ar">'+esc(sh(a.areaDesc))+'</p><p class="mt">'+esc((a.severity||'Unknown')+' · '+(a.urgency||'Monitoring'))+'</p><p class="sb">What this means</p><ul>'+b+'</ul><div class="ac"><button class="btn p" type="button">'+esc(act(a.event))+'</button><a class="btn s" href="'+esc(href)+'" target="_blank" rel="noopener noreferrer">View Details</a></div><p class="tm">Expires: '+esc(fmt(a.expires))+' · Updated: '+esc(fmt(a.updated||a.sent))+'</p><p class="tm">'+esc(ul(a.expires))+'</p></article>';};
const hMini=(arr)=>arr.length?arr.map(a=>'<article class="mini '+th(k(a.event))+'"><p class="ev">'+esc(a.event)+'</p><p class="ar">'+esc(sh(a.areaDesc,26))+'</p><p class="tm">'+esc(ul(a.expires))+'</p></article>').join(''):'<div class="empty">No additional active alerts for this area.</div>';
const hRows=(arr,lim)=>arr.length?arr.slice(0,lim).map(a=>{const href=/^https?:\/\//i.test(a.nwsUrl||'')?a.nwsUrl:'#',cp=bl(a)[0]||'Tap for details.';return'<a class="row '+th(k(a.event))+'" href="'+esc(href)+'" target="_blank" rel="noopener noreferrer"><div><p class="ev">'+esc(a.event)+'</p><p class="cp">'+esc(cp)+'</p></div><p class="ar">'+esc(sh(a.areaDesc,24))+'</p></a>';}).join(''):'<div class="empty">No active alerts right now.</div>';
const nav=(t)=>{qa('.sc').forEach(s=>s.classList.toggle('on',s.getAttribute('data-screen')===t));qa('.tab').forEach(x=>x.classList.toggle('on',x.getAttribute('data-target')===t));};
const setBd=(n)=>{if(!badge)return;if(n>0){badge.textContent=String(Math.min(n,99));badge.classList.add('on');}else{badge.textContent='0';badge.classList.remove('on');}};
const render=()=>{const arr=scoped().sort(srt),p=arr[0]||null,state=arr.length?'ACTIVE_ALERTS':'NO_ALERTS',code=eff(),title=loc?.label||(code==='all'?'United States':st(code));if(locLbl)locLbl.textContent='Location: '+title;if(stateSum)stateSum.textContent=code==='all'?'All states':st(code);if(chip){chip.textContent=state==='ACTIVE_ALERTS'?'Alerts Active':'No Alerts';chip.className='chip '+(state==='ACTIVE_ALERTS'?'a':'c');}if(hero)hero.innerHTML=hHero(p,title);if(mini)mini.innerHTML=hMini(arr.slice(1,4));if(topRows)topRows.innerHTML=hRows(arr,8);if(allRows)allRows.innerHTML=hRows(arr,24);if(fcBanner){if(state==='ACTIVE_ALERTS'&&p){fcBanner.className='bn a';fcBanner.innerHTML='<h3>Forecast With Active Alert</h3><p>'+esc(p.event)+' is active. Dangerous periods are highlighted below.</p>';}else{fcBanner.className='bn c';fcBanner.innerHTML='<h3>Calm Forecast Outlook</h3><p>No urgent alerts right now. Focus on trends and planning.</p>';}}if(rdBanner){if(state==='ACTIVE_ALERTS'&&p){rdBanner.className='bn a';rdBanner.innerHTML='<h3>Radar In Alert Mode</h3><p>Tracking: '+esc(p.event)+' · Updated 2 min ago</p>';}else{rdBanner.className='bn c';rdBanner.innerHTML='<h3>Quiet Radar</h3><p>No active storms nearby. Explore layers and regional patterns.</p>';}}setBd(arr.length);};
const show=()=>{if(gate)gate.classList.remove('h');if(gateErr)gateErr.textContent='';},hide=()=>{if(gate)gate.classList.add('h');if(gateErr)gateErr.textContent='';};
const gErr=(m)=>{if(gateErr)gateErr.textContent=m||'';};
const busy=(on)=>{if(allowBtn)allowBtn.disabled=on;if(zipBtn)zipBtn.disabled=on;if(zipSubmit)zipSubmit.disabled=on;};
const byZip=async(z)=>{const r=await fetch('/api/geocode?zip='+encodeURIComponent(z));const j=await r.json();if(!r.ok)throw new Error(j?.error||'Unable to geocode ZIP code.');return j;};
const byLatLon=async(lat,lon)=>{const r=await fetch('/api/geocode?lat='+encodeURIComponent(String(lat))+'&lon='+encodeURIComponent(String(lon)));const j=await r.json();if(!r.ok)throw new Error(j?.error||'Unable to resolve your location.');return j;};
if(allowBtn){allowBtn.addEventListener('click',async()=>{gErr('');busy(true);allowBtn.textContent='Requesting location...';try{const p=await new Promise((ok,no)=>navigator.geolocation.getCurrentPosition(ok,no,{enableHighAccuracy:true,timeout:10000,maximumAge:300000}));const l=await byLatLon(p.coords.latitude,p.coords.longitude);loc=l;setLoc(l);if(l?.state){sel=String(l.state).toUpperCase();setState(sel);if(stateSel)stateSel.value=sel;}hide();render();}catch(e){gErr(e instanceof Error?e.message:'Location access was denied or unavailable.');}finally{busy(false);allowBtn.textContent='Allow Location';}});}
if(zipBtn){zipBtn.addEventListener('click',()=>{if(!zipForm)return;zipForm.classList.toggle('on');if(zipForm.classList.contains('on')&&zipInput)zipInput.focus();});}
if(zipForm){zipForm.addEventListener('submit',async(ev)=>{ev.preventDefault();gErr('');const z=String(zipInput?.value||'').trim();if(!/^\d{5}$/.test(z)){gErr('Enter a valid 5-digit ZIP code.');return;}busy(true);if(zipSubmit)zipSubmit.textContent='Looking up ZIP...';try{const l=await byZip(z);loc=l;setLoc(l);if(l?.state){sel=String(l.state).toUpperCase();setState(sel);if(stateSel)stateSel.value=sel;}hide();render();}catch(e){gErr(e instanceof Error?e.message:'Unable to geocode ZIP code.');}finally{busy(false);if(zipSubmit)zipSubmit.textContent='Use ZIP Code';}});}
if(stateSel){if(sel==='all'){stateSel.value='all';}else if(Array.from(stateSel.options).some(o=>o.value===sel)){stateSel.value=sel;}stateSel.addEventListener('change',()=>{sel=String(stateSel.value||'all').toUpperCase();if(sel==='ALL')sel='all';setState(sel);render();});}
if(resetBtn){resetBtn.addEventListener('click',()=>{loc=null;clrLoc();sel='all';setState('all');if(stateSel)stateSel.value='all';render();show();});}
qa('.tab').forEach(t=>t.addEventListener('click',()=>nav(t.getAttribute('data-target')||'home')));nav('home');render();if(!loc)show();
`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Live Weather Alerts</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Anton&family=Barlow+Condensed:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
<style>${css}</style>
</head>
<body>
<div class="app">
<header class="top"><div class="b"><div class="bi">!</div><h1>Live Weather Alerts</h1></div><div class="tl"><button type="button" class="tbn" aria-label="Search">S</button><button type="button" class="tbn" aria-label="Menu">M</button></div></header>
<section class="sc on" data-screen="home">${syncError ? `<p class="sw">Sync warning: ${utils.safeHtml(syncError)}</p>` : ''}<div class="st"><p class="loc" id="locLbl">Location: United States</p><p class="chip ${alertState === 'ACTIVE_ALERTS' ? 'a' : 'c'}" id="chip">${alertState === 'ACTIVE_ALERTS' ? 'Alerts Active' : 'No Alerts'}</p></div><div id="hero">${hero}</div><section class="pn"><div class="hd"><h3>More Alerts</h3><p>Next highest priority</p></div><div class="mr" id="mini">${mini}</div></section><section class="pn"><div class="hd"><h3>Current Conditions</h3><p>Updated from nearest station</p></div><div class="cc"><div class="tb"><p>Scattered storms</p><p class="v">72°</p><p>Feels like 75°</p></div><div class="sl"><p><span>Wind</span><strong>S 18 mph</strong></p><p><span>Humidity</span><strong>64%</strong></p><p><span>UV Index</span><strong>6 High</strong></p><p><span>Visibility</span><strong>8 mi</strong></p></div></div></section><section class="pn"><div class="hd"><h3>Hourly Forecast</h3><p>Next 6 hours</p></div><div class="hr"><article class="h"><p>Now</p><span>72°</span></article><article class="h"><p>4 PM</p><span>75°</span></article><article class="h"><p>5 PM</p><span>74°</span></article><article class="h"><p>6 PM</p><span>71°</span></article><article class="h"><p>7 PM</p><span>68°</span></article><article class="h"><p>8 PM</p><span>65°</span></article></div></section><section class="pn"><div class="hd"><h3>Live Radar</h3><p>Updated 2 min ago</p></div><div class="rd"><div class="ov"><p>Storm motion NE</p><button type="button" class="btn s">View Radar</button></div></div></section><section class="pn"><div class="hd"><h3>Alert Headlines</h3><p>Latest active alerts</p></div><div class="rw" id="topRows">${rowList(headlines.slice(0, 8))}</div></section></section>
<section class="sc" data-screen="forecast"><div class="bn ${alertState === 'ACTIVE_ALERTS' ? 'a' : 'c'}" id="fcBanner"><h3>${alertState === 'ACTIVE_ALERTS' && primary ? 'Forecast With Active Alert' : 'Calm Forecast Outlook'}</h3><p>${alertState === 'ACTIVE_ALERTS' && primary ? utils.safeHtml(primary.event) + ' is active. Dangerous periods are highlighted below.' : 'No urgent alerts right now. Focus on trends and planning.'}</p></div><section class="pn"><div class="hd"><h3>Today</h3><p>Feels like 75° · Wind S 18 mph</p></div><div class="cc"><div class="tb"><p>Partly stormy</p><p class="v">72°</p><p>Rain chance 40%</p></div><div class="sl"><p><span>Sunrise</span><strong>6:54 AM</strong></p><p><span>Sunset</span><strong>7:24 PM</strong></p><p><span>Dew Point</span><strong>60°</strong></p><p><span>Pressure</span><strong>29.83</strong></p></div></div></section></section>
<section class="sc" data-screen="radar"><div class="bn ${alertState === 'ACTIVE_ALERTS' ? 'a' : 'c'}" id="rdBanner"><h3>${alertState === 'ACTIVE_ALERTS' && primary ? 'Radar In Alert Mode' : 'Quiet Radar'}</h3><p>${alertState === 'ACTIVE_ALERTS' && primary ? 'Tracking: ' + utils.safeHtml(primary.event) + ' · Updated 2 min ago' : 'No active storms nearby. Explore layers and regional patterns.'}</p></div><section class="pn"><div class="hd"><h3>Radar Controls</h3><p>Play · Zoom · Layers</p></div><div class="rd"><div class="ov"><button type="button" class="btn p">Play / Pause</button><button type="button" class="btn s">Layers</button></div></div></section><section class="pn"><div class="hd"><h3>Quick Alert Summary</h3><p>Top risks now</p></div><div class="rw" id="allRows">${rowList(headlines)}</div></section></section>
<section class="sc" data-screen="alerts"><section class="pn"><div class="hd"><h3>All Active Alerts</h3><p>Warnings first</p></div><div class="rw">${rowList(headlines)}</div></section></section>
<section class="sc" data-screen="more"><section class="pn"><div class="hd"><h3>Location & Preferences</h3><p id="stateSum">All states</p></div><div class="mo"><div class="fd"><label for="stateFilter">Alert Scope</label><select id="stateFilter"><option value="all">All states</option>${stateOptions}</select></div><button type="button" id="resetBtn">Reset saved location</button><p class="ft">Last synced: ${utils.safeHtml(lastSynced)}</p><p class="ft">Warnings: ${warningCount} · Watches: ${watchCount} · Advisories: ${advisoryCount}</p></div></section></section>
<nav class="nv" aria-label="Primary"><button type="button" class="tab on" data-target="home"><span class="ic">H</span><span class="lb">Home</span></button><button type="button" class="tab" data-target="forecast"><span class="ic">F</span><span class="lb">Forecast</span></button><button type="button" class="tab" data-target="radar"><span class="ic">R</span><span class="lb">Radar</span></button><button type="button" class="tab" data-target="alerts"><span class="ic">A</span><span class="lb">Alerts</span><span class="bd" id="badge">0</span></button><button type="button" class="tab" data-target="more"><span class="ic">M</span><span class="lb">More</span></button></nav>
</div>
<div class="gt h" id="gate" role="dialog" aria-modal="true" aria-labelledby="gateTitle"><div class="gp"><p>Local weather</p><h2 id="gateTitle">Enable location for local weather alerts?</h2><p style="margin-top:8px">Use your current location, or enter ZIP code for local alerts.</p><div class="ga"><button type="button" class="p" id="allowBtn">Allow Location</button><button type="button" id="zipBtn">Enter ZIP Code Instead</button></div><form class="zf" id="zipForm"><input id="zipInput" inputmode="numeric" maxlength="5" placeholder="Enter ZIP code" /><button type="submit" id="zipSubmit">Use ZIP Code</button></form><p class="ge" id="gateErr"></p></div></div>
<script>${script}</script>
</body>
</html>`;
}
