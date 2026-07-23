// api/nutrition-lookup.js
// Server-side "sosání" nutričních dat z veřejných webů kaloricketabulky.cz a nutridatabaze.cz.
// Uživatel NIKDY není přesměrován - vše se stáhne a zparsuje tady na serveru a klientovi
// se vrátí jen čistá čísla (kcal, bílkoviny, sacharidy, tuky) v JSON.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function stripDiacritics(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function decodeHtmlEntities(s) {
  if (!s) return s;
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function normalizeForMatch(s) {
  return stripDiacritics(String(s || '').toLowerCase()).replace(/[^a-z0-9]+/g, ' ').trim();
}

async function fetchText(url, timeoutMs, ua) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, timeoutMs || 8000);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': ua || UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'cs-CZ,cs;q=0.9,en;q=0.5',
        'Referer': 'https://www.google.com/'
      },
      redirect: 'follow',
      signal: controller.signal
    });
    clearTimeout(timer);
    const html = await res.text();
    return { ok: res.ok, status: res.status, html: html };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, status: 0, html: '', error: String(e && e.message || e) };
  }
}

// Vytáhne první číslo (desetinné, s čárkou i tečkou) po dané textové značce v HTML.
function extractNumberAfterLabel(html, label, windowSize) {
  const idx = html.indexOf(label);
  if (idx === -1) return null;
  const slice = html.slice(idx + label.length, idx + label.length + (windowSize || 500));
  const text = slice.replace(/<[^>]+>/g, ' ');
  const m = /(\d+(?:[.,]\d+)?)/.exec(text);
  if (!m) return null;
  return parseFloat(m[1].replace(',', '.'));
}

// ---------- NutriDatabaze.cz ----------
async function lookupNutriDatabaze(query) {
  const q = normalizeForMatch(query);
  if (!q) return { success: false, message: 'Zadej prosím název potraviny.' };
  const firstWord = q.split(' ')[0] || '';
  let letter = stripDiacritics(firstWord.charAt(0) || '').toUpperCase();
  if (!/^[A-Z]$/.test(letter)) letter = '';

  const listUrl = 'https://www.nutridatabaze.cz/vyhledavani-potravin/podle-abecedy/?letter=' + encodeURIComponent(letter);
  const listRes = await fetchText(listUrl, 12000);
  if (!listRes.ok) return { success: false, message: 'NutriDatabázi se teď nepodařilo načíst (HTTP ' + listRes.status + (listRes.error ? ', ' + listRes.error : '') + ').' };

  const anchors = [];
  const anchorRe = /<a\b([^>]*)>/gi;
  let m;
  while ((m = anchorRe.exec(listRes.html))) {
    const attrs = m[1];
    const hrefM = /href="([^"]*)"/i.exec(attrs);
    const titleM = /title="([^"]*)"/i.exec(attrs);
    if (hrefM && /\/potraviny\/\?id=(\d+)/.test(hrefM[1]) && titleM) {
      const idM = /id=(\d+)/.exec(hrefM[1]);
      anchors.push({ id: idM[1], name: decodeHtmlEntities(titleM[1]) });
    }
  }
  if (!anchors.length) return { success: false, message: 'V NutriDatabázi se nic nenašlo (stránka písmene "' + letter + '" vrátila HTTP ' + listRes.status + ', ' + listRes.html.length + ' znaků, 0 shod formátu odkazu na potravinu).' };

  // dedup podle id
  const seen = {};
  const items = anchors.filter(function (a) {
    if (seen[a.id]) return false;
    seen[a.id] = true;
    return true;
  });

  // skórování shody
  const qWords = q.split(' ').filter(Boolean);
  let best = null, bestScore = -Infinity;
  items.forEach(function (item) {
    const n = normalizeForMatch(item.name);
    let score = 0;
    if (n === q) score = 1000;
    else if (n.indexOf(q) === 0) score = 500;
    else {
      let hit = 0;
      qWords.forEach(function (w) { if (n.indexOf(w) !== -1) hit++; });
      score = hit * 10 - Math.abs(n.length - q.length) * 0.1;
      if (hit < qWords.length) score -= 50;
    }
    if (score > bestScore) { bestScore = score; best = item; }
  });
  if (!best || bestScore < -10) return { success: false, message: 'V NutriDatabázi (' + items.length + ' položek pod písmenem "' + letter + '") jsem nenašel odpovídající potravinu pro "' + query + '".' };

  const detailUrl = 'https://www.nutridatabaze.cz/potraviny/?id=' + best.id;
  const detailRes = await fetchText(detailUrl, 12000);
  if (!detailRes.ok) return { success: false, message: 'Nepodařilo se načíst detail "' + best.name + '" z NutriDatabáze (HTTP ' + detailRes.status + ').' };
  const html = detailRes.html;

  const kcal = extractNumberAfterLabel(html, 'Energetická hodnota (kcal)');
  const protein = extractNumberAfterLabel(html, 'Bílkoviny celkové');
  const carbs = extractNumberAfterLabel(html, 'Sacharidy celkové');
  const fat = extractNumberAfterLabel(html, 'Tuky celkové');

  if (kcal == null) return { success: false, message: 'Potravina "' + best.name + '" nalezena, ale hodnoty (kcal) se z detailu nepodařilo přečíst (HTTP ' + detailRes.status + ', ' + html.length + ' znaků).' };

  return {
    success: true,
    source: 'NutriDatabáze.cz',
    matchedName: best.name,
    kcal: Math.round(kcal),
    protein: protein != null ? protein : 0,
    carbs: carbs != null ? carbs : 0,
    fat: fat != null ? fat : 0,
    per: '100 g'
  };
}

// ---------- KalorickeTabulky.cz ----------
//
// DŮLEŽITÁ POZNÁMKA (proč je tenhle soubor přepsaný):
// KalorickeTabulky.cz NENÍ server-rendered web - je to čistě klientská
// Angular aplikace. Server posílá úplně stejnou prázdnou HTML šablonu
// komukoliv (běžnému UA, Googlebotu, čemukoliv) - v ní jsou jen doslovné
// placeholdery typu "{{f.energy}}", "{{item.value}}" atd. Čísla se do
// stránky dosadí až v prohlížeči přes JavaScript (AJAX dotaz + Angular
// binding). To je ověřené přímým stažením reálné stránky potraviny.
// Proto ŽÁDNÝ obyčejný server-side fetch (ať už s jakýmkoliv User-Agentem)
// nemůže čísla nikdy najít - v HTML z holého fetch() prostě nikdy nejsou.
// Navíc neplatný/neexistující slug KT tiše přesměruje na stránku kategorie
// (ne na 404), takže "HTTP 200" ještě neznamená, že jde o správnou potravinu.
//
// ŘEŠENÍ: místo holého fetch() necháme stránku vykreslit přes Jina Reader
// (r.jina.ai) - veřejnou bezplatnou službu, která stránku otevře v headless
// prohlížeči (Puppeteer), počká na dokončení JS renderu a vrátí čistý
// text/markdown už s reálnými čísly místo "{{...}}" šablon. Hlavička
// "X-Engine: browser" si vynutí plné vykreslení (ne jen rychlý HTML fetch).

function slugify(query) {
  return stripDiacritics(String(query || '').toLowerCase())
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const JINA_READER_PREFIX = 'https://r.jina.ai/';

// Stáhne stránku přes Jina Reader (renderuje JS v headless prohlížeči).
// Vrací vykreslený text/markdown, ne syrové HTML.
async function fetchViaReader(url, timeoutMs, waitSeconds) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, timeoutMs || 20000);
  try {
    const res = await fetch(JINA_READER_PREFIX + url, {
      headers: {
        'Accept': 'text/plain',
        'X-Engine': 'browser',
        'X-Timeout': String(waitSeconds || 12),
        'X-No-Cache': 'true'
      },
      redirect: 'follow',
      signal: controller.signal
    });
    clearTimeout(timer);
    const text = await res.text();
    return { ok: res.ok, status: res.status, text: text };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, status: 0, text: '', error: String(e && e.message || e) };
  }
}

// Najde kcal hodnotu ve vykresleném textu. Primárně hledá formát "121 kcal"
// (číslo bezprostředně před jednotkou - takhle se obvykle zobrazuje hlavní
// velké číslo na stránce potraviny). Záložně zkusí "Energetická hodnota"
// následovanou číslem (dovoluje i zalomení řádku mezi labelem a hodnotou).
function findKcalValue(text) {
  let m = /(\d+(?:[.,]\d+)?)\s*kcal\b/i.exec(text);
  if (m) return parseFloat(m[1].replace(',', '.'));
  m = /Energetick[aá] hodnota[\s\S]{0,60}?(\d+(?:[.,]\d+)?)/i.exec(text);
  if (m) return parseFloat(m[1].replace(',', '.'));
  m = /data\.foodstuff\.energy\}\}[^0-9\n]{0,20}?(\d+(?:[.,]\d+)?)/i.exec(text);
  if (m) return parseFloat(m[1].replace(',', '.'));
  return null;
}

// Najde hodnotu makroživiny (bílkoviny/sacharidy/tuky) v gramech. Label a
// hodnota bývají na stránce odděleny zalomením řádku, proto mezera mezi
// nimi smí obsahovat i "\n" (na rozdíl od dřívější verze).
function findGramValue(text, labelPattern, placeholderPattern) {
  let re = new RegExp(labelPattern + '[\\s\\S]{0,60}?(\\d+(?:[.,]\\d+)?)\\s*g\\b', 'i');
  let m = re.exec(text);
  if (m) return parseFloat(m[1].replace(',', '.'));
  // záložně: hodnota může být bez jednotky "g" hned vedle (jen tabulkové číslo)
  re = new RegExp(labelPattern + '[\\s\\S]{0,60}?(\\d+(?:[.,]\\d+)?)', 'i');
  m = re.exec(text);
  if (m) return parseFloat(m[1].replace(',', '.'));
  if (placeholderPattern) {
    m = new RegExp(placeholderPattern + '[^0-9\\n]{0,20}?(\\d+(?:[.,]\\d+)?)', 'i').exec(text);
    if (m) return parseFloat(m[1].replace(',', '.'));
  }
  return null;
}

// Zparsuje výstup Jina Readeru pro stránku jedné potraviny na KT.
// Ověří, že jde skutečně o stránku potraviny (ne přesměrování na kategorii)
// pomocí řádku "URL Source:", který Reader vrací s finální URL po redirectu.
//
// POZNÁMKA: s "X-Engine: browser" Reader stránku plně vyrenderuje, takže
// Angular "{{...}}" placeholdery obvykle úplně zmizí a zůstanou jen reálné
// hodnoty (např. "121 kcal", "Bílkoviny 11,5 g") - proto se primárně hledá
// podle skutečného textu, ne podle placeholderů (ty zůstávají jen jako
// poslední záložní varianta pro případ, že by render z nějakého důvodu
// neproběhl úplně).
function parseKtReaderText(text) {
  if (!text) return null;

  const urlSourceM = /URL Source:\s*(\S+)/i.exec(text);
  const finalUrl = urlSourceM ? urlSourceM[1] : '';
  if (finalUrl && !/\/potraviny\//.test(finalUrl)) return null; // přesměrováno na kategorii = slug neexistuje

  const kcal = findKcalValue(text);
  if (kcal == null) return null;
  const protein = findGramValue(text, 'B[ií]lkovin\\w*', 'data\\.foodstuff\\.protein\\}\\}');
  const carbs = findGramValue(text, 'Sacharid\\w*', 'data\\.foodstuff\\.carbohydrate\\}\\}');
  const fat = findGramValue(text, 'Tuk\\w*', 'data\\.foodstuff\\.fat\\}\\}');

  const titleM = /^Title:\s*(.+)$/im.exec(text);
  let matchedName = titleM ? titleM[1] : '';
  matchedName = matchedName.split(' - kalorie')[0].split(' | ')[0].trim();

  return {
    kcal: Math.round(kcal),
    protein: protein != null ? protein : 0,
    carbs: carbs != null ? carbs : 0,
    fat: fat != null ? fat : 0,
    matchedName: matchedName || null
  };
}

async function fetchAndParseKtPage(slug, debugParts, label) {
  const url = 'https://www.kaloricketabulky.cz/potraviny/' + slug;
  const res = await fetchViaReader(url, 20000, 12);
  if (debugParts) debugParts.push((label || 'stránka "' + slug + '"') + ': Reader HTTP ' + res.status + (res.error ? ' (' + res.error + ')' : ''));
  if (!res.ok) return null;
  const data = parseKtReaderText(res.text);
  if (!data && debugParts) {
    const kcalIdx = res.text.search(/kcal/i);
    const nearby = kcalIdx !== -1 ? res.text.slice(Math.max(0, kcalIdx - 40), kcalIdx + 20).replace(/\s+/g, ' ') : '(slovo "kcal" v textu vůbec není)';
    debugParts.push('stránka nalezena, ale hodnoty se nepodařilo přečíst (' + res.text.length + ' znaků; kolem "kcal": "' + nearby + '")');
  }
  return data;
}

// Najde kandidátní odkazy na /potraviny/ přes vyhledávače, routováno přes
// Jina Reader (obchází blokaci datacenterových IP z Vercelu). DuckDuckGo i
// Bing často odkazy nezobrazují přímo, ale zabalené do vlastního
// přesměrovacího odkazu (DuckDuckGo: "uddg=<cílová URL>", Bing: "u=a1<cílová
// URL v base64>") - proto je potřeba každý nalezený odkaz nejdřív "rozbalit".
function resolveWrappedUrl(href) {
  if (!href) return href;
  const uddgM = /[?&]uddg=([^&]+)/i.exec(href);
  if (uddgM) {
    let v = uddgM[1];
    try { v = decodeURIComponent(v); } catch (e) { /* uddg bývá i nekódované, to je ok */ }
    return v;
  }
  const bingM = /[?&]u=a1([^&]+)/i.exec(href);
  if (bingM) {
    let b64 = bingM[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    try { return Buffer.from(b64, 'base64').toString('utf8'); } catch (e) { /* nešlo dekódovat, necháme původní href */ }
  }
  return href;
}

function extractKtLinksFromReaderText(text) {
  const out = [];
  const seen = {};
  const addFromUrl = function (rawUrl, name) {
    const resolved = resolveWrappedUrl(rawUrl);
    const slugM = /kaloricketabulky\.cz\/potraviny\/([a-z0-9-]+)/i.exec(resolved);
    if (!slugM) return;
    const slug = slugM[1].toLowerCase();
    if (seen[slug]) return;
    seen[slug] = true;
    out.push({ slug: slug, name: (name && name.trim()) || slug.replace(/-/g, ' ') });
  };
  // markdown odkazy: [Název](URL)
  const linkRe = /\[([^\]]+)\]\((\S+?)\)/g;
  let m;
  while ((m = linkRe.exec(text))) addFromUrl(m[2], decodeHtmlEntities(m[1]));
  // fallback: i holé URL bez markdown odkazu (kdyby Reader odkaz nepřevedl na markdown)
  const bareRe = /https?:\/\/[^\s)]+/g;
  while ((m = bareRe.exec(text))) addFromUrl(m[0], null);
  return out;
}

async function findKtCandidatesViaSearch(query) {
  const debugParts = [];

  const bingUrl = 'https://www.bing.com/search?q=' +
    encodeURIComponent('site:kaloricketabulky.cz/potraviny ' + query);
  const bingRes = await fetchViaReader(bingUrl, 15000, 8);
  if (bingRes.ok) {
    const links = extractKtLinksFromReaderText(bingRes.text);
    if (links.length) return { links: links, debug: null };
    debugParts.push('Bing (přes Reader) HTTP ' + bingRes.status + ', 0 odkazů (' + bingRes.text.length + ' znaků, začátek: "' + bingRes.text.slice(0, 160).replace(/\s+/g, ' ') + '")');
  } else {
    debugParts.push('Bing (přes Reader) HTTP ' + bingRes.status);
  }

  const ddgUrl = 'https://html.duckduckgo.com/html/?q=' +
    encodeURIComponent('site:kaloricketabulky.cz/potraviny ' + query);
  const ddgRes = await fetchViaReader(ddgUrl, 15000, 8);
  if (ddgRes.ok) {
    const links = extractKtLinksFromReaderText(ddgRes.text);
    if (links.length) return { links: links, debug: null };
    debugParts.push('DuckDuckGo (přes Reader) HTTP ' + ddgRes.status + ', 0 odkazů (' + ddgRes.text.length + ' znaků, začátek: "' + ddgRes.text.slice(0, 160).replace(/\s+/g, ' ') + '")');
  } else {
    debugParts.push('DuckDuckGo (přes Reader) HTTP ' + ddgRes.status);
  }

  return { links: [], debug: debugParts.join('; ') };
}

// Vrátí seznam kandidátů (název + slug) pro živý našeptávač v UI - nejprve
// zkusí přímý slug z dotazu (ověřený přes Reader), pak doplní o výsledky
// z vyhledávání, ať uživatel vidí přesné názvy tak, jak je má KT v databázi.
async function suggestKalorickeTabulky(query) {
  const q = String(query || '').trim();
  if (q.length < 2) return { success: true, candidates: [] };

  const candidates = [];
  const seenSlug = {};
  const addCandidate = function (slug, name) {
    if (!slug || seenSlug[slug]) return;
    seenSlug[slug] = true;
    candidates.push({ slug: slug, name: name || slug.replace(/-/g, ' ') });
  };

  const directSlug = slugify(q);
  if (directSlug) {
    const data = await fetchAndParseKtPage(directSlug);
    if (data) addCandidate(directSlug, data.matchedName || q);
  }

  const found = await findKtCandidatesViaSearch(q);
  (found.links || []).slice(0, 5).forEach(function (l) { addCandidate(l.slug, l.name); });

  return { success: true, candidates: candidates.slice(0, 6), debug: candidates.length ? null : found.debug };
}

// Přímý dotaz na konkrétní slug (bez fuzzy hledání) - používá se, když
// uživatel vybral položku z živého našeptávače, takže víme přesný slug a
// jméno musí sedět 1:1 s tím, co je na KT.
async function lookupKalorickeTabulkyBySlug(slug) {
  const s = String(slug || '').trim();
  if (!s) return { success: false, message: 'Chybí slug potraviny.' };
  const debugParts = [];
  const data = await fetchAndParseKtPage(s, debugParts, 'stránka "' + s + '"');
  if (!data) return { success: false, message: 'Nepodařilo se načíst hodnoty pro tuto potravinu z Kalorických tabulek. (' + debugParts.join('; ') + ')' };
  return Object.assign({ success: true, source: 'KalorickéTabulky.cz', per: '100 g' }, data);
}

async function lookupKalorickeTabulky(query) {
  const q = String(query || '').trim();
  if (!q) return { success: false, message: 'Zadej prosím název potraviny.' };

  const debugParts = [];
  const slug = slugify(q);
  if (slug) {
    const data = await fetchAndParseKtPage(slug, debugParts, 'přímý slug "' + slug + '"');
    if (data) return Object.assign({ success: true, source: 'KalorickéTabulky.cz', per: '100 g' }, data);
  }

  // fallback: najít správnou stránku přes vyhledávání (bez přesměrování uživatele - hledá server)
  const found = await findKtCandidatesViaSearch(q);
  if (found.links && found.links.length) {
    for (let i = 0; i < Math.min(3, found.links.length); i++) {
      const cand = found.links[i];
      const data2 = await fetchAndParseKtPage(cand.slug, debugParts, 'kandidát "' + cand.name + '"');
      if (data2) return Object.assign({ success: true, source: 'KalorickéTabulky.cz', per: '100 g' }, data2);
    }
  } else {
    debugParts.push(found.debug || 'vyhledávací fallback bez výsledku');
  }

  return { success: false, message: 'Na Kalorických tabulkách se "' + q + '" nepodařilo najít. (' + debugParts.join('; ') + ')' };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const source = (req.query.source || '').toString();
  const q = (req.query.q || '').toString();
  const slug = (req.query.slug || '').toString();

  if (source === 'kalorickeTabulky' && slug.trim()) {
    try {
      const result = await lookupKalorickeTabulkyBySlug(slug);
      res.status(200).json(result);
    } catch (e) {
      res.status(200).json({ success: false, message: 'Nastala chyba při vyhledávání: ' + String(e && e.message || e) });
    }
    return;
  }

  if (!q.trim()) {
    res.status(400).json({ success: false, message: 'Chybí parametr q (název potraviny).' });
    return;
  }

  try {
    let result;
    if (source === 'nutriDatabaze') {
      result = await lookupNutriDatabaze(q);
    } else if (source === 'kalorickeTabulky') {
      result = await lookupKalorickeTabulky(q);
    } else if (source === 'kalorickeTabulkySuggest') {
      result = await suggestKalorickeTabulky(q);
    } else {
      result = { success: false, message: 'Neznámý zdroj.' };
    }
    res.status(200).json(result);
  } catch (e) {
    res.status(200).json({ success: false, message: 'Nastala chyba při vyhledávání: ' + String(e && e.message || e) });
  }
}
