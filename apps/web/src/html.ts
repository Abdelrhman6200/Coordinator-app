/**
 * Server-rendered HTML.
 *
 * No client framework and no build step, deliberately: the frontline screens
 * (§73) must work on a poor connection, and a form post that degrades to a full
 * page load is the most reliable thing a browser does. Progressive enhancement
 * sits on top; nothing depends on it.
 */
import { MODULES, type Module } from '@coordinator/permissions';

export function esc(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export type Locale = 'en' | 'ar';

const NAV_LABELS: Record<Module, { en: string; ar: string; href: string }> = {
  home: { en: 'Home', ar: 'الرئيسية', href: '/' },
  my_work: { en: 'My Work', ar: 'مهامي', href: '/my-work' },
  students: { en: 'Students', ar: 'الطلاب', href: '/students' },
  groups: { en: 'Groups', ar: 'المجموعات', href: '/groups' },
  communications: { en: 'Communications', ar: 'التواصل', href: '/communications' },
  sessions: { en: 'Sessions', ar: 'الجلسات', href: '/sessions' },
  freelancing: { en: 'Freelancing', ar: 'العمل الحر', href: '/freelancing' },
  services: { en: 'Services', ar: 'الخدمات', href: '/services' },
  evidence: { en: 'Evidence', ar: 'الأدلة', href: '/evidence' },
  quality: { en: 'Quality', ar: 'الجودة', href: '/quality' },
  graduation: { en: 'Graduation', ar: 'التخرج', href: '/graduation' },
  risks: { en: 'Risks', ar: 'المخاطر', href: '/risks' },
  escalations: { en: 'Escalations', ar: 'التصعيد', href: '/escalations' },
  team: { en: 'Team', ar: 'الفريق', href: '/team' },
  performance: { en: 'Performance', ar: 'الأداء', href: '/performance' },
  reports: { en: 'Reports', ar: 'التقارير', href: '/reports' },
  notifications: { en: 'Notifications', ar: 'الإشعارات', href: '/notifications' },
  audit: { en: 'Audit', ar: 'السجل', href: '/audit' },
  administration: { en: 'Administration', ar: 'الإدارة', href: '/admin' },
  portal: { en: 'My Progress', ar: 'تقدمي', href: '/portal' },
};

const STYLE = `
:root {
  --bg: #f6f7f9; --surface: #fff; --ink: #16191d; --muted: #5b6472;
  --line: #dfe3e8; --accent: #1f4fd8; --accent-ink: #fff;
  --green: #0f7b45; --amber: #a1620a; --red: #b3261e;
  --green-bg: #e6f4ec; --amber-bg: #fdf3e2; --red-bg: #fdeceb;
  --radius: 8px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14161a; --surface: #1c1f24; --ink: #e9edf2; --muted: #9aa4b2;
    --line: #2c313a; --accent: #7ba1ff; --accent-ink: #10131a;
    --green: #5cc98d; --amber: #e0a94b; --red: #f08079;
    --green-bg: #16281f; --amber-bg: #2a2114; --red-bg: #2b1917;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans Arabic", sans-serif;
}
/* Logical properties throughout, so the Arabic layout is a real mirror rather
   than a set of overrides. */
header.app {
  display: flex; align-items: center; gap: 1rem; padding: .75rem 1rem;
  background: var(--surface); border-block-end: 1px solid var(--line);
  position: sticky; inset-block-start: 0; z-index: 10; flex-wrap: wrap;
}
header.app .brand { font-weight: 650; margin-inline-end: auto; }
nav.modules { display: flex; gap: .25rem; flex-wrap: wrap; }
nav.modules a {
  padding: .35rem .6rem; border-radius: var(--radius); color: var(--muted);
  text-decoration: none; font-size: 14px;
}
nav.modules a:hover { background: var(--bg); color: var(--ink); }
nav.modules a[aria-current="page"] { background: var(--accent); color: var(--accent-ink); }
main { padding: 1.25rem; max-width: 1200px; margin-inline: auto; }
h1 { font-size: 1.35rem; margin: 0 0 .25rem; }
h2 { font-size: 1.05rem; margin: 1.5rem 0 .5rem; }
p.sub { color: var(--muted); margin: 0 0 1rem; }
.cards { display: grid; gap: .75rem; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); }
.card {
  background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius);
  padding: .8rem; text-decoration: none; color: inherit; display: block;
}
.card:hover { border-color: var(--accent); }
.card .label { color: var(--muted); font-size: 13px; }
.card .value { font-size: 1.6rem; font-weight: 650; margin-block-start: .2rem; }
.card .foot { color: var(--muted); font-size: 12px; margin-block-start: .2rem; }
table { width: 100%; border-collapse: collapse; background: var(--surface);
        border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }
th, td { text-align: start; padding: .55rem .7rem; border-block-end: 1px solid var(--line);
         font-size: 14px; vertical-align: top; }
th { background: var(--bg); font-weight: 600; color: var(--muted); font-size: 13px; }
tr:last-child td { border-block-end: 0; }
.wrap { overflow-x: auto; }
.pill { display: inline-block; padding: .1rem .45rem; border-radius: 999px; font-size: 12px;
        font-weight: 600; }
.pill.green { background: var(--green-bg); color: var(--green); }
.pill.amber { background: var(--amber-bg); color: var(--amber); }
.pill.red { background: var(--red-bg); color: var(--red); }
form.panel { background: var(--surface); border: 1px solid var(--line);
             border-radius: var(--radius); padding: 1rem; display: grid; gap: .75rem; }
label { display: grid; gap: .25rem; font-size: 13px; color: var(--muted); font-weight: 600; }
input, select, textarea {
  font: inherit; padding: .5rem; border: 1px solid var(--line); border-radius: 6px;
  background: var(--bg); color: var(--ink); width: 100%;
}
button {
  font: inherit; font-weight: 600; padding: .55rem 1rem; border-radius: 6px;
  border: 1px solid var(--accent); background: var(--accent); color: var(--accent-ink);
  cursor: pointer;
}
button.secondary { background: transparent; color: var(--ink); border-color: var(--line); }
.row { display: flex; gap: .6rem; flex-wrap: wrap; align-items: end; }
.notice { padding: .7rem .9rem; border-radius: var(--radius); border: 1px solid var(--line);
          background: var(--surface); margin-block-end: 1rem; }
.notice.error { border-color: var(--red); background: var(--red-bg); color: var(--red); }
.notice.ok { border-color: var(--green); background: var(--green-bg); color: var(--green); }
.empty { padding: 2rem; text-align: center; color: var(--muted); background: var(--surface);
         border: 1px dashed var(--line); border-radius: var(--radius); }
.checks { display: grid; gap: .4rem; }
.checks label { display: flex; gap: .5rem; align-items: center; font-weight: 500;
                color: var(--ink); }
.checks input { width: auto; }
.muted { color: var(--muted); font-size: 13px; }
.target-row { display: grid; gap: .75rem; grid-template-columns: repeat(auto-fit, minmax(240px,1fr)); }
@media (max-width: 640px) {
  main { padding: .75rem; }
  th, td { padding: .45rem .5rem; }
}
`;

export interface LayoutOptions {
  title: string;
  locale: Locale;
  modules: readonly Module[];
  currentPath: string;
  userName?: string;
  body: string;
}

export function layout(o: LayoutOptions): string {
  const dir = o.locale === 'ar' ? 'rtl' : 'ltr';
  const nav = MODULES.filter((m) => o.modules.includes(m))
    .map((m) => {
      const item = NAV_LABELS[m];
      const current = o.currentPath === item.href ? ' aria-current="page"' : '';
      return `<a href="${item.href}"${current}>${esc(item[o.locale])}</a>`;
    })
    .join('');

  const otherLocale = o.locale === 'ar' ? 'en' : 'ar';
  return `<!doctype html>
<html lang="${o.locale}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)} · Coordinator</title>
<style>${STYLE}</style>
</head>
<body>
<header class="app">
  <span class="brand">DEPI R5</span>
  <nav class="modules">${nav}</nav>
  <a class="muted" href="?locale=${otherLocale}">${otherLocale === 'ar' ? 'العربية' : 'English'}</a>
  ${o.userName ? `<span class="muted">${esc(o.userName)}</span>` : ''}
  <form method="post" action="/logout" style="display:inline">
    <button class="secondary" type="submit">${o.locale === 'ar' ? 'خروج' : 'Sign out'}</button>
  </form>
</header>
<main>${o.body}</main>
</body>
</html>`;
}

export function loginPage(error?: string): string {
  return `<!doctype html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · Coordinator</title>
<style>${STYLE}
main { max-width: 380px; margin-block-start: 12vh; }</style>
</head>
<body>
<main>
  <h1>DEPI Round 5</h1>
  <p class="sub">Operations platform</p>
  ${error ? `<div class="notice error">${esc(error)}</div>` : ''}
  <form class="panel" method="post" action="/login">
    <label>Email<input name="email" type="email" autocomplete="username" required autofocus></label>
    <label>Password
      <input name="password" type="password" autocomplete="current-password" required></label>
    <button type="submit">Sign in</button>
  </form>
</main>
</body>
</html>`;
}

export function riskPill(level: string): string {
  const cls = level === 'red' ? 'red' : level === 'amber' ? 'amber' : 'green';
  const label = level === 'red' ? 'Critical' : level === 'amber' ? 'At Risk' : 'Normal';
  return `<span class="pill ${cls}">${label}</span>`;
}

export function slaPill(state: string | null): string {
  if (!state) return '<span class="muted">—</span>';
  const cls = state === 'breached' ? 'red' : state === 'approaching' ? 'amber' : 'green';
  return `<span class="pill ${cls}">${esc(state)}</span>`;
}

export function card(label: string, value: unknown, href?: string, foot?: string): string {
  const inner = `<div class="label">${esc(label)}</div>
    <div class="value">${esc(value)}</div>
    ${foot ? `<div class="foot">${esc(foot)}</div>` : ''}`;
  // Every tile links to the records behind it (§74): a tile without a
  // drill-down is a defect, so the non-linked form is only for pure context.
  return href ? `<a class="card" href="${href}">${inner}</a>` : `<div class="card">${inner}</div>`;
}
