/**
 * The few HTML pages a person sees in their browser: the sign-in (consent)
 * page of the OAuth flow, a landing page, the privacy notice and the page to
 * disconnect an account. Slovak, because the audience is Czech and Slovak.
 *
 * Pages are self-contained (inline CSS, no scripts, no third-party requests)
 * and are sent with their own security headers, so a deployment does not
 * depend on the reverse proxy adding them.
 */

import type { Response } from 'express';
import type { Operator } from '../config.js';

/** Public source repository, linked from the landing and privacy pages. */
export const SOURCE_URL = 'https://github.com/MarosMacko/kt-mcp';

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

const STYLE = `
  :root { color-scheme: light dark; --accent: #2e7d32; --muted: #8884; }
  body { font-family: system-ui, sans-serif; max-width: 34rem; margin: 2.5rem auto; padding: 0 1.25rem; line-height: 1.55; }
  h1 { font-size: 1.35rem; margin-bottom: .25rem; }
  h2 { font-size: 1.05rem; margin: 1.6rem 0 .4rem; }
  .lead { opacity: .8; margin-top: 0; }
  label { display: block; font-weight: 600; margin: 1.1rem 0 .35rem; }
  input[type=email], input[type=password] { width: 100%; padding: .6rem .7rem; font-size: 1rem; border: 1px solid #999; border-radius: .4rem; box-sizing: border-box; }
  fieldset.site { border: 0; padding: 0; margin: 1.1rem 0 0; }
  fieldset.site legend { font-weight: 600; margin-bottom: .45rem; padding: 0; }
  fieldset.site label { display: flex; align-items: center; gap: .6rem; font-weight: 400; margin: 0 0 .45rem;
    padding: .65rem .75rem; border: 1px solid #999; border-radius: .4rem; cursor: pointer; }
  fieldset.site label:has(input:checked) { border-color: var(--accent); outline: 2px solid var(--accent); }
  fieldset.site input { margin: 0; width: 1.1rem; height: 1.1rem; accent-color: var(--accent); }
  fieldset.site .hint { font-size: .84rem; opacity: .75; margin: .1rem 0 0; }
  button { margin-top: 1.4rem; width: 100%; padding: .65rem; font-size: 1rem; font-weight: 600; border: 0; border-radius: .4rem; background: var(--accent); color: #fff; cursor: pointer; }
  button.danger { background: #b3261e; }
  .error { background: #fdecea; color: #8a1c12; padding: .6rem .75rem; border-radius: .4rem; margin-top: 1rem; }
  .ok { background: #e6f4ea; color: #1e4620; padding: .6rem .75rem; border-radius: .4rem; margin-top: 1rem; }
  .small { font-size: .84rem; opacity: .75; margin-top: 1.5rem; border-top: 1px solid var(--muted); padding-top: .75rem; }
  code, .url { font-family: ui-monospace, monospace; background: var(--muted); padding: .1rem .35rem; border-radius: .25rem; word-break: break-all; }
  footer { margin-top: 2.5rem; font-size: .84rem; opacity: .7; }
  footer a { margin-right: .9rem; }
`;

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="sk"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style></head><body>
${body}
<footer><a href="/">Úvod</a><a href="/privacy">Ochrana súkromia</a><a href="/forget">Odpojiť účet</a><a href="${SOURCE_URL}">Zdrojový kód</a></footer>
</body></html>`;
}

/**
 * Sends a page with strict headers. `formTargets` lists extra CSP form-action
 * sources: browsers apply form-action to the redirect that follows a form
 * POST, so the consent page must allow the client's redirect origin.
 */
export function sendPage(res: Response, status: number, html: string, options: { formTargets?: string[]; index?: boolean } = {}): void {
  const formAction = ["'self'", ...(options.formTargets ?? [])].join(' ');
  res.status(status);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader(
    'Content-Security-Policy',
    `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
  );
  res.setHeader('X-Frame-Options', 'DENY');
  // Not no-referrer: that makes browsers send `Origin: null` on the form POST, which the Origin check refuses.
  res.setHeader('Referrer-Policy', 'same-origin');
  if (!options.index) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.send(html);
}

/** The CSP source a redirect URI needs: its origin, or its scheme for app-specific schemes. */
export function formTargetFor(redirectUri: string): string | null {
  try {
    const url = new URL(redirectUri);
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.origin;
    return url.protocol;
  } catch {
    return null;
  }
}

/** Who the redirect hands the result to, in words a person can check. */
function requesterLine(clientName: string, redirectUri: string): string {
  let where: string;
  try {
    const url = new URL(redirectUri);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    where = loopback ? 'aplikácia na tvojom počítači (localhost)' : url.host;
  } catch {
    where = redirectUri;
  }
  return `Žiada: <strong>${escapeHtml(clientName)}</strong> · výsledok dostane <strong>${escapeHtml(where)}</strong>`;
}

export type SiteChoice = 'cz' | 'sk';

/**
 * Which Kalorické tabuľky the account lives on. The two sites have separate
 * logins, so this picks where the sign-in is checked (and the language of food
 * names). Shown first and stacked, so nobody signs in against the wrong site.
 */
function siteChoice(site: SiteChoice): string {
  const option = (value: SiteChoice, label: string) =>
    `<label><input type="radio" name="site" value="${value}"${site === value ? ' checked' : ''} required> ${label}</label>`;
  return `<fieldset class="site">
    <legend>Kde máš účet?</legend>
    ${option('sk', '<strong>kaloricketabulky.sk</strong>&nbsp;(slovenská verzia)')}
    ${option('cz', '<strong>kaloricketabulky.cz</strong>&nbsp;(česká verzia)')}
    <p class="hint">Účty na .sk a .cz sú oddelené. Vyber stránku, na ktorej sa prihlasuješ.</p>
  </fieldset>`;
}

export interface ConsentPageInput {
  clientName: string;
  redirectUri: string;
  hidden: Record<string, string | undefined>;
  error: string | null;
  email: string;
  /** Preselected site: 'sk' or 'cz'. */
  site: SiteChoice;
  restricted: boolean;
}

export function consentPage(input: ConsentPageInput): string {
  const hidden = Object.entries(input.hidden)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join('\n  ');
  return layout(
    'Prepojiť s Kalorickými tabuľkami',
    `<h1>Prepojiť s Kalorickými tabuľkami</h1>
<p class="lead">Prihlás sa účtom z Kalorických tabuliek. Tvoj AI asistent potom bude môcť čítať a zapisovať tvoj jedálniček.</p>
${input.restricted ? '<p class="lead">Tento server je len pre pozvaných používateľov.</p>' : ''}
${input.error ? `<div class="error">${escapeHtml(input.error)}</div>` : ''}
<form method="POST">
  ${hidden}
  ${siteChoice(input.site)}
  <label for="email">E-mail</label>
  <input type="email" id="email" name="email" value="${escapeHtml(input.email)}" autocomplete="username" autofocus required maxlength="200">
  <label for="password">Heslo</label>
  <input type="password" id="password" name="password" autocomplete="current-password" required maxlength="200">
  <button type="submit">Prihlásiť a povoliť</button>
</form>
<div class="small">
  ${requesterLine(input.clientName, input.redirectUri)}<br>
  Prihlásením súhlasíš, aby tento server v tvojom mene pristupoval k tvojmu jedálničku
  (vrátane údajov ako váha), podľa <a href="/privacy">zásad ochrany súkromia</a>. Server si uloží
  len zašifrovaný odtlačok hesla, nie heslo samotné. Ten však na prihlásenie do Kalorických tabuliek
  stačí, preto tam používaj heslo, ktoré nemáš nikde inde. Odpojiť sa môžeš kedykoľvek.
</div>`,
  );
}

export function landingPage(publicUrl: URL, restricted: boolean): string {
  const endpoint = new URL('/mcp', publicUrl).href;
  return layout(
    'Kalorické tabuľky pre AI asistenta',
    `<h1>Kalorické tabuľky pre AI asistenta</h1>
<p class="lead">Neoficiálny MCP server, ktorý prepojí Claude, ChatGPT alebo iného AI asistenta s tvojím jedálničkom na
kaloricketabulky.sk / .cz. Povieš „na raňajky som mal dve vajcia a rožok“ a asistent to zapíše.</p>
${restricted ? '<p>Tento server je len pre pozvaných používateľov. Vlastný si môžeš spustiť podľa návodu v zdrojovom kóde.</p>' : ''}
<h2>Adresa konektora</h2>
<p><span class="url">${escapeHtml(endpoint)}</span></p>
<h2>Ako ho pridať</h2>
<ul>
  <li><strong>Claude</strong> (web, desktop aj mobil): Nastavenia → Konektory → Pridať vlastný konektor → vlož adresu vyššie.
    Na mobile sa konektor objaví sám, keď ho pridáš na webe.</li>
  <li><strong>ChatGPT</strong>: Nastavenia → Aplikácie a konektory → Vytvoriť (vyžaduje zapnutý vývojársky režim).</li>
  <li><strong>Claude Code</strong>: <code>claude mcp add --transport http kaloricke-tabulky ${escapeHtml(endpoint)}</code></li>
  <li><strong>Iné aplikácie</strong> (VS Code, Cursor, …): pridaj vzdialený MCP server typu HTTP s adresou vyššie.</li>
</ul>
<p>Pri pridaní sa otvorí prihlasovacia stránka tohto servera. Vyberieš, či máš účet na kaloricketabulky.sk alebo .cz
(účty sú oddelené), a zadáš e-mail a heslo z tej stránky.</p>
<h2>Dôležité</h2>
<ul>
  <li>Neoficiálny projekt, nie je od Dine4Fit, a.s. (prevádzkovateľa Kalorických tabuliek).</li>
  <li>Je zadarmo a bez akejkoľvek záruky. Ak prestane fungovať, prestane fungovať.</li>
  <li>Ako sa zaobchádza s tvojimi údajmi: <a href="/privacy">Ochrana súkromia</a>.</li>
</ul>`,
  );
}

export function privacyPage(operator: Operator): string {
  const who = operator.name ? escapeHtml(operator.name) : 'Prevádzkovateľ tohto servera';
  const contact = operator.contact
    ? /^https?:\/\//.test(operator.contact)
      ? `<a href="${escapeHtml(operator.contact)}">${escapeHtml(operator.contact)}</a>`
      : `<a href="mailto:${escapeHtml(operator.contact)}">${escapeHtml(operator.contact)}</a>`
    : null;
  return layout(
    'Ochrana súkromia',
    `<h1>Ochrana súkromia</h1>
<p class="lead">Stručne a zrozumiteľne: čo tento server o tebe vie a ako sa toho zbavíš.</p>

<h2>Kto server prevádzkuje</h2>
<p>${who}${contact ? `, kontakt: ${contact}` : '.'} Server je neoficiálny (nie je od Dine4Fit, a.s.),
zadarmo a bez záruky.</p>

<h2>Čo sa ukladá</h2>
<ul>
  <li><strong>Prihlásenie do Kalorických tabuliek:</strong> tvoj e-mail a MD5 odtlačok hesla (heslo samotné nie).
    Sú uložené šifrovane a kľúč na ich dešifrovanie má len tvoj AI asistent v podobe prístupového tokenu.
    Na serveri nie je tvoj e-mail ani token v čitateľnej podobe.</li>
  <li><strong>Údaje o pripojených aplikáciách:</strong> názov a adresa aplikácie (napr. Claude), ktorá sa pripojila.</li>
</ul>

<h2>Čo sa neukladá</h2>
<ul>
  <li><strong>Tvoj jedálniček, váha a aktivity.</strong> Server ich len prenáša medzi AI asistentom a Kalorickými tabuľkami.
    Výsledky vyhľadávania potravín si môže krátko pamätať v operačnej pamäti (nie na disku).</li>
  <li><strong>IP adresa</strong> sa používa len na obmedzenie počtu pokusov o prihlásenie, drží sa v pamäti najviac hodinu.
    Webový server pred aplikáciou môže viesť bežné technické záznamy o prístupoch.</li>
</ul>

<h2>Prečo</h2>
<p>Aby tvoj AI asistent mohol na tvoj pokyn čítať a zapisovať tvoj jedálniček. Keďže ide aj o údaje o zdraví
(napr. váha), spracúvajú sa len na základe tvojho výslovného súhlasu, ktorý dávaš prihlásením. Údaje sa nepredávajú,
neanalyzujú a nikomu sa neposkytujú. Posielajú sa len do Kalorických tabuliek a tvojmu AI asistentovi (napr. Anthropic
alebo OpenAI), ktorého si si sám vybral.</p>

<h2>Ako dlho</h2>
<p>Kým si pripojený. Ak tvoj asistent server 60 dní nepoužije, uložené prihlásenie sa automaticky zmaže.</p>

<h2>Ako sa odpojiť a zmazať údaje</h2>
<ul>
  <li>Povedz asistentovi: <em>„Odpoj môj účet Kalorických tabuliek z tohto servera.“</em> (nástroj <code>disconnect_account</code>), alebo</li>
  <li>použi stránku <a href="/forget">Odpojiť účet</a>, alebo</li>
  <li>si zmeň heslo v Kalorických tabuľkách. Uložený odtlačok tým stratí platnosť okamžite.</li>
</ul>
<p>Otázky, prístup k údajom alebo námietky${contact ? `: ${contact}` : ' adresuj prevádzkovateľovi servera'}.</p>

<h2>Chceš mať všetko pod kontrolou?</h2>
<p>Zdrojový kód je verejný. Vlastný server si môžeš spustiť podľa návodu na <a href="${SOURCE_URL}">GitHube</a>.</p>`,
  );
}

export type ForgetOutcome = 'done' | 'nothing' | 'rejected' | 'blocked' | 'unreachable' | 'invalid';

const FORGET_MESSAGES: Record<ForgetOutcome, { ok: boolean; text: string }> = {
  done: { ok: true, text: 'Hotovo. Uložené prihlásenie aj všetky prístupy tvojich AI asistentov sú zmazané.' },
  nothing: { ok: true, text: 'Na tomto serveri nemáš uložené žiadne prihlásenie. Nie je čo mazať.' },
  rejected: { ok: false, text: 'Kalorické tabuľky odmietli prihlásenie. Skontroluj e-mail, heslo a či máš účet na .sk alebo .cz. Ak si si heslo zmenil, staré uložené prihlásenie už neplatí a do 60 dní sa samo zmaže.' },
  blocked: { ok: false, text: 'Príliš veľa pokusov. Skús to znova o 15 minút.' },
  unreachable: { ok: false, text: 'Kalorické tabuľky teraz neodpovedajú. Skús to o chvíľu znova.' },
  invalid: { ok: false, text: 'Vyplň e-mail aj heslo.' },
};

export function forgetPage(outcome: ForgetOutcome | null, email: string, site: SiteChoice): string {
  const message = outcome ? FORGET_MESSAGES[outcome] : null;
  return layout(
    'Odpojiť účet',
    `<h1>Odpojiť účet</h1>
<p class="lead">Zmaže z tohto servera tvoje uložené prihlásenie a odpojí všetkých tvojich AI asistentov.
Tvoj jedálniček v Kalorických tabuľkách zostane nedotknutý.</p>
<p>Aby nikto nemohol odpojiť cudzí účet, over sa prihlasovacími údajmi do Kalorických tabuliek.</p>
${message ? `<div class="${message.ok ? 'ok' : 'error'}">${escapeHtml(message.text)}</div>` : ''}
<form method="POST">
  ${siteChoice(site)}
  <label for="email">E-mail</label>
  <input type="email" id="email" name="email" value="${escapeHtml(email)}" autocomplete="username" required maxlength="200">
  <label for="password">Heslo</label>
  <input type="password" id="password" name="password" autocomplete="current-password" required maxlength="200">
  <button type="submit" class="danger">Odpojiť a zmazať</button>
</form>`,
  );
}
