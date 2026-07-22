// api/nutrition-lookup.js
// Server-side "sosání" nutričních dat z veřejných webů kaloricketabulky.cz a nutridatabaze.cz.
// Uživatel NIKDY není přesměrován - vše se stáhne a zparsuje tady na serveru a klientovi
// se vrátí jen čistá čísla (kcal, bílkoviny, sacharidy, tuky) v JSON.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
// KT (a spousta jiných SPA webů) posílá plně vyrenderovaný obsah s čísly jen
// rozpoznaným crawlerům kvůli SEO; běžnému serverovému požadavku (i s
// "prohlížečovým" UA) může poslat jen prázdnou šablonu. Googlebot UA je
// legitimní způsob, jak dostat tu samou veřejnou stránku, kterou web sám
// nabízí k indexaci.
const CRAWLER_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

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

// Stáhne stránku potraviny na KT a zparsuje ji. Nejdřív zkusí běžný UA,
// a pokud stránka dorazí bez dat (prázdná SPA šablona), zopakuje dotaz s
// UA Googlebota - u SEO-prerenderovaných webů to bývá rozdíl mezi "nic" a
// plnými čísly.
async function fetchAndParseKtPage(url, debugParts, label) {
  const res1 = await fetchText(url, 12000, UA);
  if (debugParts) debugParts.push((label || 'stránka') + ': HTTP ' + res1.status);
  if (res1.ok) {
    const data1 = extractFromKtHtml(res1.html);
    if (data1) return data1;
    if (debugParts) debugParts.push('běžný UA: stránka nalezena, ale hodnoty se v HTML nenašly');
  }
  const res2 = await fetchText(url, 12000, CRAWLER_UA);
  if (debugParts) debugParts.push((label || 'stránka') + ' (Googlebot UA): HTTP ' + res2.status);
  if (res2.ok) {
    const data2 = extractFromKtHtml(res2.html);
    if (data2) return data2;
    if (debugParts) debugParts.push('Googlebot UA: stránka nalezena, ale hodnoty se v HTML nenašly');
  }
  return null;
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
function slugify(query) {
  return stripDiacritics(String(query || '').toLowerCase())
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// KT vkládá mezi Angular {{ }} placeholder a vyrenderovanou hodnotu často HTML
// komentáře nebo tagy (prerender markup). Přísný "žádný znak mezi labelem a
// číslem" regex proto na reálných stránkách často selže, i když stránka i
// hodnoty v ní jsou v pořádku. Místo toho vezmeme okno textu za labelem,
// odstraníme z něj tagy/komentáře a teprve v očištěném textu hledáme číslo -
// to je odolné vůči drobným změnám markupu.
function extractNumberAfterKtLabel(html, label, windowSize) {
  const idx = html.indexOf(label);
  if (idx === -1) return null;
  const slice = html.slice(idx + label.length, idx + label.length + (windowSize || 80));
  const text = slice.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ');
  const m = /(\d+(?:[.,]\d+)?)/.exec(text);
  if (!m) return null;
  return parseFloat(m[1].replace(',', '.'));
}

function extractFromKtHtml(html) {
  const kcal = extractNumberAfterKtLabel(html, 'data.foodstuff.energy}}', 60);
  const protein = extractNumberAfterKtLabel(html, 'data.foodstuff.protein}}', 60);
  const carbs = extractNumberAfterKtLabel(html, 'data.foodstuff.carbohydrate}}', 60);
  const fat = extractNumberAfterKtLabel(html, 'data.foodstuff.fat}}', 60);
  if (kcal == null) return null;
  const titleM = /<title>([^<]*)<\/title>/i.exec(html);
  let matchedName = titleM ? decodeHtmlEntities(titleM[1]) : '';
  matchedName = matchedName.split(' - kalorie')[0].split(' | ')[0].trim();
  return {
    kcal: Math.round(kcal),
    protein: protein != null ? protein : 0,
    carbs: carbs != null ? carbs : 0,
    fat: fat != null ? fat : 0,
    matchedName: matchedName || null
  };
}

// Vrátí VŠECHNY odkazy na /potraviny/ z výsledků DuckDuckGo (ne jen první),
// s názvem potraviny odvozeným z odkazu - používá se pro "did you mean" seznam
// a pro živý našeptávač v UI (aby se vybíral přesný název, jaký na KT existuje).
function extractKtLinksFromDdg(html) {
  const out = [];
  const seen = {};
  const anchorRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = anchorRe.exec(html))) {
    let href = m[1];
    const uddgM = /uddg=([^&]+)/.exec(href);
    const finalUrl = uddgM ? decodeURIComponent(uddgM[1]) : href;
    if (!/kaloricketabulky\.cz\/potraviny\//.test(finalUrl)) continue;
    const slugM = /\/potraviny\/([^/?#]+)/.exec(finalUrl);
    if (!slugM) continue;
    const slug = slugM[1];
    if (seen[slug]) continue;
    seen[slug] = true;
    const rawName = decodeHtmlEntities(m[2].replace(/<[^>]+>/g, '').trim());
    out.push({ slug: slug, name: rawName || slug.replace(/-/g, ' ') });
  }
  return out;
}

async function findKtLinksViaDuckDuckGo(query) {
  const searchUrl = 'https://html.duckduckgo.com/html/?q=' +
    encodeURIComponent('site:kaloricketabulky.cz/potraviny ' + query);
  const res = await fetchText(searchUrl, 10000);
  if (!res.ok) return { links: [], debug: 'DuckDuckGo HTTP ' + res.status };
  const links = extractKtLinksFromDdg(res.html);
  if (!links.length) return { links: [], debug: 'DuckDuckGo HTTP ' + res.status + ', 0 odkazů (' + res.html.length + ' znaků odpovědi)' };
  return { links: links, debug: null };
}

// Bing bývá z datacenterových IP (Vercel) méně náchylný na blokaci než
// DuckDuckGo, takže slouží jako druhá šance, pokud DDG selže (HTTP 403 apod.).
function extractKtLinksFromBing(html) {
  const out = [];
  const seen = {};
  const anchorRe = /<h2><a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>/gi;
  let m;
  while ((m = anchorRe.exec(html))) {
    const href = m[1];
    if (!/kaloricketabulky\.cz\/potraviny\//.test(href)) continue;
    const slugM = /\/potraviny\/([^/?#]+)/.exec(href);
    if (!slugM) continue;
    const slug = decodeURIComponent(slugM[1]);
    if (seen[slug]) continue;
    seen[slug] = true;
    const rawName = decodeHtmlEntities(m[2].replace(/<[^>]+>/g, '').trim());
    out.push({ slug: slug, name: rawName || slug.replace(/-/g, ' ') });
  }
  return out;
}

async function findKtLinksViaBing(query) {
  const searchUrl = 'https://www.bing.com/search?q=' +
    encodeURIComponent('site:kaloricketabulky.cz/potraviny ' + query);
  const res = await fetchText(searchUrl, 10000);
  if (!res.ok) return { links: [], debug: 'Bing HTTP ' + res.status };
  const links = extractKtLinksFromBing(res.html);
  if (!links.length) return { links: [], debug: 'Bing HTTP ' + res.status + ', 0 odkazů (' + res.html.length + ' znaků odpovědi)' };
  return { links: links, debug: null };
}

async function findKtUrlViaWebSearch(query) {
  const ddg = await findKtLinksViaDuckDuckGo(query);
  if (ddg.links.length) return { url: 'https://www.kaloricketabulky.cz/potraviny/' + ddg.links[0].slug, links: ddg.links, debug: null };
  const bing = await findKtLinksViaBing(query);
  const debugParts = [ddg.debug, bing.debug].filter(Boolean);
  if (bing.links.length) return { url: 'https://www.kaloricketabulky.cz/potraviny/' + bing.links[0].slug, links: bing.links, debug: null };
  return { url: null, links: [], debug: debugParts.join('; ') || 'bez výsledku' };
}

// Vrátí seznam kandidátů (název + slug) pro živý našeptávač v UI - nejprve
// zkusí přímý slug z dotazu, pak doplní o výsledky z DuckDuckGo a Bingu, ať
// uživatel vidí přesné názvy tak, jak je má KT v databázi.
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
    const data = await fetchAndParseKtPage('https://www.kaloricketabulky.cz/potraviny/' + directSlug);
    if (data) addCandidate(directSlug, data.matchedName || q);
  }

  const found = await findKtUrlViaWebSearch(q);
  (found.links || []).forEach(function (l) { addCandidate(l.slug, l.name); });

  return { success: true, candidates: candidates.slice(0, 6), debug: candidates.length ? null : found.debug };
}

// Přímý dotaz na konkrétní slug (bez fuzzy hledání) - používá se, když
// uživatel vybral položku z živého našeptávače, takže víme přesný slug a
// jméno musí sedět 1:1 s tím, co je na KT.
async function lookupKalorickeTabulkyBySlug(slug) {
  const s = String(slug || '').trim();
  if (!s) return { success: false, message: 'Chybí slug potraviny.' };
  const data = await fetchAndParseKtPage('https://www.kaloricketabulky.cz/potraviny/' + s);
  if (!data) return { success: false, message: 'Nepodařilo se načíst hodnoty pro tuto potravinu z Kalorických tabulek.' };
  return Object.assign({ success: true, source: 'KalorickéTabulky.cz', per: '100 g' }, data);
}

async function lookupKalorickeTabulky(query) {
  const q = String(query || '').trim();
  if (!q) return { success: false, message: 'Zadej prosím název potraviny.' };

  const slug = slugify(q);
  const debugParts = [];
  if (slug) {
    const data = await fetchAndParseKtPage('https://www.kaloricketabulky.cz/potraviny/' + slug, debugParts, 'přímý slug "' + slug + '"');
    if (data) return Object.assign({ success: true, source: 'KalorickéTabulky.cz', per: '100 g' }, data);
  }

  // fallback: najít správnou stránku přes DuckDuckGo/Bing (bez přesměrování uživatele - hledá server)
  const found = await findKtUrlViaWebSearch(q);
  if (found.url) {
    const data2 = await fetchAndParseKtPage(found.url, debugParts, 'web search výsledek');
    if (data2) return Object.assign({ success: true, source: 'KalorickéTabulky.cz', per: '100 g' }, data2);
  } else {
    debugParts.push(found.debug || 'web search fallback bez výsledku');
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
