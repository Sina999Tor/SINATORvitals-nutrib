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

async function fetchText(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, timeoutMs || 8000);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
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
function slugify(query) {
  return stripDiacritics(String(query || '').toLowerCase())
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function extractFromKtHtml(html) {
  const energyM = /data\.foodstuff\.energy\}\}\s*([\d\s]+)\s*kcal/i.exec(html);
  const proteinM = /data\.foodstuff\.protein\}\}\s*([\d.,]+)\s*g/i.exec(html);
  const carbsM = /data\.foodstuff\.carbohydrate\}\}\s*([\d.,]+)\s*g/i.exec(html);
  const fatM = /data\.foodstuff\.fat\}\}\s*([\d.,]+)\s*g/i.exec(html);
  if (!energyM) return null;
  const titleM = /<title>([^<]*)<\/title>/i.exec(html);
  let matchedName = titleM ? decodeHtmlEntities(titleM[1]) : '';
  matchedName = matchedName.split(' - kalorie')[0].split(' | ')[0].trim();
  return {
    kcal: Math.round(parseFloat(energyM[1].replace(/\s/g, ''))),
    protein: proteinM ? parseFloat(proteinM[1].replace(',', '.')) : 0,
    carbs: carbsM ? parseFloat(carbsM[1].replace(',', '.')) : 0,
    fat: fatM ? parseFloat(fatM[1].replace(',', '.')) : 0,
    matchedName: matchedName || null
  };
}

async function findKtUrlViaDuckDuckGo(query) {
  const searchUrl = 'https://html.duckduckgo.com/html/?q=' +
    encodeURIComponent('site:kaloricketabulky.cz/potraviny ' + query);
  const res = await fetchText(searchUrl, 12000);
  if (!res.ok) return { url: null, debug: 'DuckDuckGo HTTP ' + res.status };
  const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"/i;
  let m = linkRe.exec(res.html);
  let href = m ? m[1] : null;
  if (!href) {
    const generic = /href="([^"]*kaloricketabulky\.cz%2Fpotraviny%2F[^"&]*|[^"]*kaloricketabulky\.cz\/potraviny\/[^"?&]*)"/i.exec(res.html);
    href = generic ? generic[1] : null;
  }
  if (!href) return { url: null, debug: 'DuckDuckGo HTTP ' + res.status + ', 0 odkazů (' + res.html.length + ' znaků odpovědi)' };
  const uddgM = /uddg=([^&]+)/.exec(href);
  const finalUrl = uddgM ? decodeURIComponent(uddgM[1]) : href;
  if (!/kaloricketabulky\.cz\/potraviny\//.test(finalUrl)) return { url: null, debug: 'nalezený odkaz nevede na kaloricketabulky.cz/potraviny' };
  return { url: finalUrl, debug: null };
}

async function lookupKalorickeTabulky(query) {
  const q = String(query || '').trim();
  if (!q) return { success: false, message: 'Zadej prosím název potraviny.' };

  const slug = slugify(q);
  const debugParts = [];
  if (slug) {
    const directRes = await fetchText('https://www.kaloricketabulky.cz/potraviny/' + slug, 12000);
    debugParts.push('přímý slug "' + slug + '": HTTP ' + directRes.status);
    if (directRes.ok) {
      const data = extractFromKtHtml(directRes.html);
      if (data) return Object.assign({ success: true, source: 'KalorickéTabulky.cz', per: '100 g' }, data);
      debugParts.push('stránka nalezena, ale hodnoty se v HTML nenašly');
    }
  }

  // fallback: najít správnou stránku přes DuckDuckGo (bez přesměrování uživatele - hledá server)
  const found = await findKtUrlViaDuckDuckGo(q);
  if (found.url) {
    const res2 = await fetchText(found.url, 12000);
    debugParts.push('DDG nalezl ' + found.url + ' (HTTP ' + res2.status + ')');
    if (res2.ok) {
      const data2 = extractFromKtHtml(res2.html);
      if (data2) return Object.assign({ success: true, source: 'KalorickéTabulky.cz', per: '100 g' }, data2);
      debugParts.push('stránka nalezena, ale hodnoty se v HTML nenašly');
    }
  } else {
    debugParts.push(found.debug || 'DDG fallback bez výsledku');
  }

  return { success: false, message: 'Na Kalorických tabulkách se "' + q + '" nepodařilo najít. (' + debugParts.join('; ') + ')' };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const source = (req.query.source || '').toString();
  const q = (req.query.q || '').toString();

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
    } else {
      result = { success: false, message: 'Neznámý zdroj.' };
    }
    res.status(200).json(result);
  } catch (e) {
    res.status(200).json({ success: false, message: 'Nastala chyba při vyhledávání: ' + String(e && e.message || e) });
  }
}
