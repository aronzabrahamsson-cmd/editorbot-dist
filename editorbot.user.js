// ==UserScript==
// @name         EditorBot
// @namespace    visitstockholm.sidbot
// @version      4.31
// @description  v4.31: Draftail-fält på vissa sid-sidor gick inte att fylla i — loggen visade "root-nycklar: 0", dvs. React sätter aldrig __reactFiber$/__reactProps$ på .DraftEditor-root där, så props-vandringen kan aldrig lyckas. När React-props saknas körs nu en paste-reserv (portrerad från EventBot v7.97.9): riktig paste-händelse → execCommand → dolt input-fält, en metod i taget med verifiering mot det dolda draft.js-fältet mellan varje steg. v4.30: inställningar överlever uppdatering, What's On fler event, GM-kontext-reserv, Draftail React 17+-props. v4.23: Fixat "Skriv till sidan" som inte gjorde något — orsaken var att kategori→sektion-mappningen (WHAT'S ON) bara kände till engelska slugs, medan API:et på .se-domänen faktiskt returnerar lokaliserade SVENSKA kategorietiketter ("musik", "scen & film", "utställningar"), bekräftat via en riktig körning där ALLA 228 event hamnade i "Övrigt" istället för Konserter/Scen & film/Museer. Lade till de svenska etiketterna i CATEGORY_TO_SECTION. Fixade även en "[object Object]"-bugg när ett kategorifält är ett objekt ({id,name}) istället för en sträng. v4.22: Steg 4 (första försöket) — "Skriv till sidan"-knappen skriver ikryssade event/guide till sidans befintliga fact_box/card_image_link-block via simulerad inklistring i Draftail, plus bildinfogning från befintlig bildbank. v4.21: Steg 3 — guide-förslag. v4.20: Steg 2 — hämtning/filtrering/kategorisering + checklista. v4.19: Steg 1 — flik, månadsväljare, inställningsfält. Äldre versioner: se git-historiken.
// @match        https://www.visitstockholm.com/cms/pages/add/main/objectpage/*
// @match        https://www.visitstockholm.se/cms/pages/add/main/objectpage/*
// @match        https://www.visitstockholm.com/cms/pages/*/edit/*
// @match        https://www.visitstockholm.se/cms/pages/*/edit/*
// @match        https://www.visitstockholm.com/cms/images/*
// @match        https://www.visitstockholm.se/cms/images/*
// @updateURL    https://raw.githubusercontent.com/aronzabrahamsson-cmd/editorbot-dist/main/editorbot.user.js
// @downloadURL  https://raw.githubusercontent.com/aronzabrahamsson-cmd/editorbot-dist/main/editorbot.user.js
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_setClipboard
// @connect      api.mistral.ai
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const MISTRAL_CONV = 'https://api.mistral.ai/v1/conversations';
  const MISTRAL_CHAT = 'https://api.mistral.ai/v1/chat/completions';
  const DEFAULT_MISTRAL_AGENT_ID = 'ag_01a00f03d056722bb5310f4738447535';
  const THEME_KEY = 'sidbot_theme';

  // Versionsnumret läses från GM_info (som hanteraren fyller från samma
  // lagrade version som koden uppdaterades med — kan aldrig driva från
  // @version-headern). Reservkonstanten används bara om GM_info saknas.
  // Används i loggens startrad och i versionsmärket i widgetarnas rubrik.
  const SCRIPT_VERSION =
    (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '4.28';
  function versionBadgeHTML() {
    return '<span style="display:inline-block;margin-left:8px;padding:1px 7px;' +
      'border-radius:5px;background:#dbe7ff;color:#0b3d91;font-size:11px;' +
      'font-weight:800;letter-spacing:.02em;vertical-align:middle;">v' + SCRIPT_VERSION + '</span>';
  }

  // ===== TEMA (mörkt/ljust) =====
  // Temat lagras globalt via GM_setValue så samma val gäller både
  // EditorBot-panelen och "Synka utvalda event"-listen, oavsett vilken av
  // dem som visas på sidan. Ljust läge sätts genom att skriva över samma
  // CSS-variabler (--vd-*) som bar/panel redan använder, via attributet
  // data-sb-theme på <html> — ingen JS-omritning av element behövs.
  const THEME_OVERRIDE_CSS = `
    :root[data-sb-theme="light"] {
      --vd-bg: #f3f4f6;
      --vd-bg2: #ffffff;
      --vd-bg3: #eceef1;
      --vd-line: #d8dbe1;
      --vd-txt: #1d2129;
      --vd-txt2: #565c66;
      --vd-txt3: #868b93;
      --vd-accent: #2f7fd1;
    }
  `;

  function getStoredTheme() {
    return GM_getValue(THEME_KEY, 'dark') === 'light' ? 'light' : 'dark';
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-sb-theme', theme === 'light' ? 'light' : 'dark');
  }

  function injectThemeOverrideStyle() {
    if (document.getElementById('sb-theme-style')) return;
    const s = document.createElement('style');
    s.id = 'sb-theme-style';
    s.textContent = THEME_OVERRIDE_CSS;
    document.head.appendChild(s);
  }
  let busy = false;
  let lastData = null;
  let VLOG = [];
  let isFilling = false;
  let successfulFills = 0;

  // ===== SIDNAMN OCH URL-MAPPNING =====
  const EP_PAGE_MAPPING = {
    'Start SE': '1458',
    'Start EN': '3',
    'S&G': '1459',
    'S&D': '7'
  };
  const EP_PAGE_NAMES = ['Start SE', 'Start EN', 'S&G', 'S&D'];
  const EP_STORAGE_KEY = 'eventportor_copied_eventlist';
  const EP_BLOCK_TYPE = 'rekai_filtered_event_list';

  // Exclude urls måste alltid finnas i BÅDA språkdomänerna, eftersom samma
  // fältvärde återanvänds oförändrat på både .se- och .com-sidan. .se
  // använder /event/ (singular), .com använder /events/ (plural) — resten av
  // sökvägen är identisk. Lägger till saknade systerlänkar i slutet av
  // fältet utan att röra befintliga rader.
  function epMirrorExcludeUrls(text) {
    const lines = (text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const existing = new Set(lines);
    const added = [];

    const SE_RE = /^(https?:\/\/(?:www\.)?)visitstockholm\.se\/event\/(.+)$/i;
    const COM_RE = /^(https?:\/\/(?:www\.)?)visitstockholm\.com\/events\/(.+)$/i;

    for (const line of lines) {
      let mirror = null;
      const seMatch = line.match(SE_RE);
      if (seMatch) {
        mirror = seMatch[1] + 'visitstockholm.com/events/' + seMatch[2];
      } else {
        const comMatch = line.match(COM_RE);
        if (comMatch) {
          mirror = comMatch[1] + 'visitstockholm.se/event/' + comMatch[2];
        }
      }
      if (mirror && !existing.has(mirror)) {
        existing.add(mirror);
        added.push(mirror);
      }
    }

    if (added.length === 0) return { text: text || '', added: [] };

    const base = (text || '').replace(/\s+$/, '');
    const newText = (base ? base + '\n' : '') + added.join('\n');
    return { text: newText, added };
  }

  // ===== HJÄLPFUNKTIONER =====
  function gmPost(url, headers, body) {
    const pageFetchFallback = (why, resolve, reject) =>
      pageFetchText(url, { method: 'POST', headers: headers, body: JSON.stringify(body), timeout: 120000 })
        .then(t => { try { resolve(JSON.parse(t)); } catch { reject(new Error('Ogiltig JSON (sid-fetch)')); } },
              fe => reject(new Error('Nätverksfel' + why + ' / sid-fetch: ' + fe.message)));
    if (gmContextDead) {
      return new Promise((resolve, reject) => pageFetchFallback('', resolve, reject));
    }
    return new Promise((resolve, reject) => {
      try {
        GM_xmlhttpRequest({
        method: 'POST', url, headers, data: JSON.stringify(body),
        onload: r => {
          if (r.status === 401) return reject(new Error('Mistral: 401'));
          if (r.status === 422) return reject(new Error('Mistral: 422'));
          if (r.status === 429) return reject(new Error('Mistral: 429'));
          if (r.status < 200 || r.status >= 300) return reject(new Error('HTTP ' + r.status));
          try { resolve(JSON.parse(r.responseText)); } catch { reject(new Error('Ogiltig JSON')); }
        },
        onerror: e => {
          const why = (e && e.error) ? ': ' + e.error : '';
          if (/Extension context invalidated/i.test(String(e && e.error))) {
            gmContextDead = true;
            vlog('GM-kontexten är död (script uppdaterat/reloadat) — använder sid-fetch för resten av sessionen.', 'warn');
          } else {
            vlog('Mistral-anrop via GM misslyckades' + why + ' — provar sid-fetch som reserv.', 'warn');
          }
          pageFetchFallback(why, resolve, reject);
        },
        ontimeout: () => reject(new Error('Timeout')), timeout: 120000
        });
      } catch (err) {
        const msg = String(err && err.message ? err.message : err);
        if (/Extension context invalidated/i.test(msg)) {
          gmContextDead = true;
          vlog('GM-kontexten är död (script uppdaterat/reloadat) — använder sid-fetch för resten av sessionen.', 'warn');
        } else {
          vlog('GM_xmlhttpRequest kastade synkront (' + msg + ') — provar sid-fetch som reserv.', 'warn');
        }
        pageFetchFallback('', resolve, reject);
      }
    });
  }

  function extractJSON(text) { if (!text) return null; try { return JSON.parse(text.trim()); } catch {} return null; }

  // Plockar ut agentens faktiska textsvar ur en /v1/conversations-respons.
  // Med verktyg (t.ex. web_search) påslagna innehåller outputs[] även
  // tool.execution-poster (själva sökanropen) FÖRE svarsmeddelandet, så
  // outputs[0] är INTE tillförlitligt längre — leta istället upp den SISTA
  // posten som faktiskt har textinnehåll (den slutgiltiga assistant-texten
  // kommer alltid efter eventuella verktygsanrop).
  function extractAgentText(resp) {
    const outputs = Array.isArray(resp?.outputs) ? resp.outputs : [];
    for (let i = outputs.length - 1; i >= 0; i--) {
      const entry = outputs[i];
      if (entry && typeof entry.content === 'string' && entry.content.trim()) return entry.content.trim();
    }
    return (resp?.messages?.[0]?.content || '').trim();
  }

  // label taggar loggraderna (t.ex. "original" / "omskrivning 2") så att
  // flera anrop i samma körning (t.ex. blocklist-omskrivningen) går att
  // skilja åt i loggen.
  async function callMistralAgentForJSON(apiKey, agentId, inputText, label) {
    const tag = label ? '[' + label + '] ' : '';

    vlog(tag + 'Skickar till Mistral (agent ' + agentId + '):');
    vlog(inputText.length > 4000 ? inputText.slice(0, 4000) + '\n…(avkortat)' : inputText);

    const resp = await gmPost(MISTRAL_CONV,
      { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      { agent_id: agentId, inputs: inputText, store: false });

    vlog(tag + 'Mistral svarade. Nycklar i svar: ' + Object.keys(resp || {}).join(', '));
    if (Array.isArray(resp?.outputs)) {
      vlog(tag + 'Output-poster (' + resp.outputs.length + '): ' + resp.outputs.map(o => o?.type || '?').join(', '));
    }

    const text = extractAgentText(resp);
    vlog(tag + 'Extraherad text: ' + (text ? text.length + ' tecken' : 'TOM'));
    if (text) vlog(tag + 'Textens början: ' + text.slice(0, 300).replace(/\n/g, '\\n'));

    const data = extractJSON(text);
    if (!data) {
      vlog(tag + 'JSON-tolkning MISSLYCKADES.', 'err');
      try { vlog(tag + 'Hela svarsobjektet (JSON): ' + JSON.stringify(resp).slice(0, 6000)); } catch {}
      vlog(tag + 'Extraherad text (hela): ' + (text ? text.slice(0, 6000) : '(tom text)'), 'err');
      throw new Error('Kunde inte tolka agentens svar som JSON. Se loggen (📋) för råsvaret.');
    }

    vlog(tag + 'JSON tolkad OK. Fält (' + Object.keys(data).length + '): ' + Object.keys(data).join(', '), 'ok');
    try { vlog(tag + 'Rådata (JSON): ' + JSON.stringify(data).slice(0, 6000)); } catch {}

    return data;
  }

  // ===== BLOCKLISTE-KONTROLL =====
  // Programmatisk kontroll som körs på agentens JSON-output för att fånga
  // klichéfyllda/överdrivna formuleringar (sv + en) innan fälten fylls i.
  // Alla strängfält utom "notes" kontrolleras. Normalisering före matchning:
  // NFC-unicode, lowercase, kollapsade mellanslag.
  const BLOCKLIST_SV = /\b(mysig\w*|cozy|charm\w*|trevlig\w*|härlig\w*|genuin\w*|unik\w*|spännande|sevärd\w*|favorit\w*|populär\w*|älskad|pärla\w*|oas\w*|doldis|guldgruva|ett måste|väl värt ett besök|något för alla|det lilla extra|hjärtat av)\b/gi;
  const BLOCKLIST_EN = /\b(best|fantastic\w*|wonderful\w*|perfect\w*|delightful\w*|charming\w*|quaint|hidden gem|must-visit|a must|beloved\w*|a gem|world-class|unforgettable\w*|gem of a)\b/gi;
  const BLOCKLIST_PATTERNS = [BLOCKLIST_SV, BLOCKLIST_EN];

  // Undantag: om objektets eget namn (title) legitimt innehåller ett annars
  // förbjudet ord (t.ex. ett café som faktiskt heter "Mysiga Hörnet"), lägg
  // till den normaliserade titeln (NFC, lowercase) här med vilka ord som
  // får förekomma just i title-fältet för det objektet.
  const BLOCKLIST_TITLE_EXCEPTIONS = {
    // 'mysiga hörnet': ['mysiga']
  };

  function normalizeForBlocklist(text) {
    return String(text).normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  // Kontrollerar alla strängfält i data (utom "notes") mot blocklistan och
  // returnerar varje träff som { field, match }. title-fältet undantas för
  // ord som finns i BLOCKLIST_TITLE_EXCEPTIONS för just den titeln.
  function checkBlocklist(data) {
    const hits = [];
    if (!data || typeof data !== 'object') return hits;

    const titleNorm = typeof data.title === 'string' ? normalizeForBlocklist(data.title) : '';
    const titleAllowed = (BLOCKLIST_TITLE_EXCEPTIONS[titleNorm] || []).map(normalizeForBlocklist);
    const seen = new Set();

    for (const key of Object.keys(data)) {
      if (key === 'notes') continue;
      const value = data[key];
      if (typeof value !== 'string' || !value) continue;

      const norm = normalizeForBlocklist(value);
      for (const pattern of BLOCKLIST_PATTERNS) {
        pattern.lastIndex = 0;
        let m;
        while ((m = pattern.exec(norm))) {
          const match = m[0];
          if (key === 'title' && titleAllowed.includes(match)) continue;
          // sv/en-listorna överlappar delvis (t.ex. "charm\w*" fångar redan
          // "charming" som även finns explicit i en-listan) — dedupe så
          // samma träff i samma fält inte rapporteras flera gånger.
          const dedupeKey = key + '|' + match;
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);
          hits.push({ field: key, match });
        }
      }
    }
    return hits;
  }

  function buildBlocklistRetryMessage(previousData, hits) {
    const hitLines = hits
      .map(h => "Förbjudet ord/mönster hittat i fältet " + h.field + ": '" + h.match + "'.")
      .join('\n');
    return hitLines +
      '\nSkriv om enligt BLOCKLISTE-KONTROLL i systemprompten och returnera om hela JSON-objektet.' +
      '\n\nFöregående JSON-objekt:\n' + JSON.stringify(previousData);
  }

  // ===== ÖVERSÄTTNING =====
  // Fälten som "Översätt till svenska/engelska" täcker: allt läsbart
  // innehåll utom sådant som ALDRIG ska ändras av en översättning — adress,
  // postnummer, stad, telefon, e-post, alla URL:er (external_link,
  // booking_link, canonical_link), slug (styr sidans egen URL), datum och
  // kryssrutor. rich_text/extra_info_text är Draftail-fält och läses/skrivs
  // därför via readDraftailText/updateDraftail, inte som vanliga textfält.
  const TRANSLATABLE_FIELDS = [
    ['title', 'id_title', 'plain'],
    ['rich_text', 'id_rich_text', 'draftail'],
    ['extra_info_text', 'id_extra_info_text', 'draftail'],
    ['seo_title', 'id_seo_title', 'plain'],
    ['search_description', 'id_search_description', 'plain'],
    ['og_title', 'id_og_title', 'plain'],
    ['og_description', 'id_og_description', 'plain'],
    ['twitter_title', 'id_twitter_title', 'plain'],
    ['twitter_description', 'id_twitter_description', 'plain'],
    ['list_title', 'id_list_title', 'plain'],
    ['external_link_text', 'id_external_link_text', 'plain'],
    ['related_events_title', 'id_related_events_title', 'plain']
  ];

  const TRANSLATE_LANG_NAME = { sv: 'svenska', en: 'amerikansk engelska (US English)' };

  function readTranslatableFields() {
    const values = {};
    for (const [key, id, kind] of TRANSLATABLE_FIELDS) {
      values[key] = kind === 'draftail' ? readDraftailText(id) : (($(id) || {}).value || '');
    }
    return values;
  }

  async function writeTranslatableFields(values) {
    let written = 0;
    for (const [key, id, kind] of TRANSLATABLE_FIELDS) {
      const text = values[key];
      if (!text) continue;
      if (kind === 'draftail') {
        if (await updateDraftail(id, text)) written++;
      } else if (simulateInput($(id), text)) {
        written++;
      }
    }
    return written;
  }

  // Samma BLOCKLISTE-KONTROLL-rubrik som objektsida-agentens systemprompt
  // använder, så buildBlocklistRetryMessage() (skriven för den agenten) kan
  // återanvändas oförändrad för översättningens omskrivningsförsök.
  function buildTranslateSystemPrompt(targetLang) {
    const langName = TRANSLATE_LANG_NAME[targetLang];
    return 'Du är en professionell översättare för Visit Stockholms webbplats.\n' +
      'Du får ett JSON-objekt där varje värde är en text som ska översättas till ' + langName + '.\n' +
      'Returnera ENBART ett JSON-objekt med EXAKT SAMMA NYCKLAR som indata, där varje värde är ' +
      'den översatta texten. Om ett värde i indata är en tom sträng ("") ska det förbli en tom ' +
      'sträng i svaret. Ingen text utanför JSON-objektet, inga kodblock, inga kommentarer.\n\n' +
      'Översätt naturligt och idiomatiskt, aldrig ord för ord.' +
      (targetLang === 'en'
        ? ' Använd AMERIKANSK engelska (US English), inte brittisk — t.ex. "neighborhood" inte ' +
          '"neighbourhood", "color" inte "colour", "center" inte "centre".'
        : '') +
      '\n\nBLOCKLISTE-KONTROLL — OVILLKORLIGT: Använd ALDRIG något av följande ord/fraser, på ' +
      'något språk, i någon böjningsform, i den översatta texten (undantag: ordet är en ' +
      'verifierbar del av objektets eget namn i title-fältet):\n' +
      '"mysig(t)", "cozy", "charmig", "trevlig", "härlig", "genuin(t)", "unik", "spännande", ' +
      '"sevärd", "favorit", "populär", "älskad", "pärla", "oas", "doldis", "guldgruva", ' +
      '"ett måste", "väl värt ett besök", "något för alla", "det lilla extra", "hjärtat av", ' +
      '"best", "fantastic", "wonderful", "perfect", "delightful", "charming", "quaint", ' +
      '"hidden gem", "must-visit", "a must", "beloved", "a gem", "world-class", "unforgettable".\n' +
      'Hittar du ett sådant ord i din egen översättning: skriv om med en konkret, saklig ' +
      'formulering istället. Kontrollera hela JSON:en en gång till innan du svarar.';
  }

  async function callTranslatorForJSON(apiKey, targetLang, userContent) {
    const body = {
      model: 'mistral-small-latest',
      messages: [
        { role: 'system', content: buildTranslateSystemPrompt(targetLang) },
        { role: 'user', content: userContent }
      ]
    };
    const resp = await gmPost(MISTRAL_CHAT,
      { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey }, body);
    const text = resp.choices?.[0]?.message?.content || '';
    const data = extractJSON(text);
    if (!data) throw new Error('Kunde inte tolka översättningssvaret som JSON.');
    return data;
  }

  // ===== WHAT'S ON =====
  // Steg 1: flik, inställningsfält och månadsväljare.
  // Steg 2: hämtning/filtrering/kategorisering av kalenderevent + checklista.
  // Steg 3: guide-förslag (card_image_link) för samma period, se
  // "GUIDE-FÖRSLAG"-sektionen längre ner.
  // Steg 4: "Skriv till sidan"-knappen, se "SKRIVSTEG"-sektionen längre ner
  // — skriver events/guide-länk till BEFINTLIGA block, sparar inte själv.
  // Kvar: kortets egen titel/text/bild, "Highlights"-sammanfattningen längst
  // upp, samt den framtida skill-prompten som ska ersätta agent-inputen.
  const MONTH_NAMES_SV = ['januari','februari','mars','april','maj','juni','juli','augusti','september','oktober','november','december'];
  const MONTH_NAMES_EN = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const DEFAULT_CALENDAR_API_COM = 'https://www.visitstockholm.com/api/v1/singulareventdates/';
  const DEFAULT_CALENDAR_API_SE = 'https://www.visitstockholm.se/api/v1/singulareventdates/';

  function isSwedishDomain() {
    return location.hostname.includes('visitstockholm.se');
  }

  function getCalendarApiBase() {
    const override = GM_getValue('sidbot_calendar_api', '').trim();
    if (override) return override;
    return isSwedishDomain() ? DEFAULT_CALENDAR_API_SE : DEFAULT_CALENDAR_API_COM;
  }

  // Månadsväljaren visar 14 månader framåt, med NÄSTA månad först —
  // det är den period man normalt förbereder näst.
  function buildWhatsOnMonthOptions() {
    const names = getWhatsOnLang() === 'sv' ? MONTH_NAMES_SV : MONTH_NAMES_EN;
    const now = new Date();
    const options = [];
    for (let i = 1; i < 15; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
      options.push({
        value: d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'),
        label: names[d.getMonth()] + ' ' + d.getFullYear()
      });
    }
    return options;
  }

  function populateWhatsOnMonthDropdown(selectEl) {
    if (!selectEl) return;
    selectEl.innerHTML = buildWhatsOnMonthOptions()
      .map(o => '<option value="' + o.value + '">' + esc(o.label) + '</option>')
      .join('');
  }

  // Steg 2: hämtning/filtrering/kategorisering av kalenderevent + checklista.
  let whatsOnState = null;

  // GM_xmlhttpRequest istället för fetch (som eventbots sameOriginGet
  // använder) — dels eftersom kalender-API:ets override-fält kan peka på
  // ANDRA domänen än den man står på, dels eftersom Biggest
  // Events/Opening Soon-sidorna nedan uttryckligen ska funka "oavsett
  // domän" (Arons ord), och GM_xmlhttpRequest kringgår CORS/SOP helt.
  // Sidkontext-fetch som reserv när GM-bryggan är död (t.ex. SW som inte
  // svarar). Funkar för same-origin och CORS-vänliga mål — kalender-
  // API:et på samma domän är precis sådant. Felmeddelandet från
  // GM-lagret loggas alltid, så den verkliga orsaken syns i loggen.
  function pageFetchText(url, opts) {
    return fetch(url, {
      method: (opts && opts.method) || 'GET',
      headers: (opts && opts.headers) || undefined,
      body: (opts && opts.body) || undefined,
      signal: AbortSignal.timeout((opts && opts.timeout) || 30000)
    }).then(r => {
      if (r.status < 200 || r.status >= 300) throw new Error('HTTP ' + r.status + ' (' + url + ')');
      return r.text();
    });
  }
  let gmContextDead = false;
  function gmGet(url) {
    if (gmContextDead) return pageFetchText(url);
    return new Promise((resolve, reject) => {
      try {
        GM_xmlhttpRequest({
        method: 'GET', url,
        onload: r => {
          if (r.status < 200 || r.status >= 300) return reject(new Error('HTTP ' + r.status + ' (' + url + ')'));
          resolve(r.responseText);
        },
        onerror: e => {
          const why = (e && e.error) ? ': ' + e.error : '';
          if (/Extension context invalidated/i.test(String(e && e.error))) {
            gmContextDead = true;
            vlog('GM-kontexten är död (script uppdaterat/reloadat) — använder sid-fetch för resten av sessionen.', 'warn');
          } else {
            vlog('GM_xmlhttpRequest misslyckades' + why + ' — provar sid-fetch som reserv.', 'warn');
          }
          pageFetchText(url).then(resolve, fe =>
            reject(new Error('Nätverksfel' + why + ' / sid-fetch: ' + fe.message + ' (' + url + ')')));
        },
        ontimeout: () => {
          vlog('GM_xmlhttpRequest timeout — provar sid-fetch som reserv.', 'warn');
          pageFetchText(url).then(resolve, fe =>
            reject(new Error('Timeout / sid-fetch: ' + fe.message + ' (' + url + ')')));
        }, timeout: 30000
        });
      } catch (err) {
        const msg = String(err && err.message ? err.message : err);
        if (/Extension context invalidated/i.test(msg)) {
          gmContextDead = true;
          vlog('GM-kontexten är död (script uppdaterat/reloadat) — använder sid-fetch för resten av sessionen.', 'warn');
          return pageFetchText(url).then(resolve, reject);
        }
        vlog('GM_xmlhttpRequest kastade synkront (' + msg + ') — provar sid-fetch som reserv.', 'warn');
        pageFetchText(url).then(resolve, reject);
      }
    });
  }

  async function gmGetJson(url) {
    const text = await gmGet(url);
    try { return JSON.parse(text); } catch { throw new Error('Ogiltig JSON från ' + url); }
  }

  // Perioden som ska täckas för en given startmånad ("YYYY-MM") — 1 månad
  // på .se (en månad i taget), 3 månader på .com (samlingssida). end är
  // EXKLUSIVT (första dagen efter periodens slut).
  // Valt språk för WHAT'S ON-flödet — explicit kryssruta i fliken
  // (Svenska förvald, ömsesidigt uteslutande) som OVERRIDAR domändetekten,
  // eftersom API-anropet till agenten skiljer sig åt mellan språken.
  const WHATSON_LANG_KEY = 'sidbot_whatson_lang';
  function getWhatsOnLang() {
    const saved = GM_getValue(WHATSON_LANG_KEY, '');
    return saved === 'en' ? 'en' : 'sv';
  }
  function setWhatsOnLang(lang) {
    GM_setValue(WHATSON_LANG_KEY, lang === 'en' ? 'en' : 'sv');
  }

  function getWhatsOnPeriodRange(monthValue) {
    const [y, m] = monthValue.split('-').map(Number);
    const start = new Date(y, m - 1, 1);
    // Alltid EXAKT en månad — sidan förbereds en månad i taget, oavsett domän.
    const end = new Date(y, m, 1);
    return { start, end };
  }

  function parseISODate(s) {
    if (!s) return null;
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  function datesOverlap(evStartStr, evEndStr, rangeStart, rangeEnd) {
    const evStart = parseISODate(evStartStr);
    if (!evStart) return false;
    const evEnd = parseISODate(evEndStr) || evStart;
    return evStart < rangeEnd && evEnd >= rangeStart;
  }

  // Säkerhetsspärr mot en oändlig loop om total_pages skulle vara felaktigt
  // (t.ex. saknas i svaret) — se samma mönster i eventbots Nortic-hämtning.
  const WHATSON_MAX_PAGES = 300;

  // Hämtar ALLA sidor av kalendern och filtrerar på period lokalt — hämtar
  // inte bara "tillräckligt många sidor" eftersom vi inte kan garantera att
  // API:et returnerar posterna i datumordning (eventbots motsvarande
  // hämtning gör samma sak, av samma anledning: korrekthet före hastighet).
  async function fetchCalendarEventsInRange(range) {
    const base = getCalendarApiBase();
    const seenIds = new Set();
    const inRange = [];
    let page = 1, totalPages = 1, rawCount = 0;
    do {
      const sep = base.includes('?') ? '&' : '?';
      const url = base + sep + 'page=' + page;
      vlog('WHAT\'S ON: hämtar kalendersida ' + page + (totalPages > 1 ? '/' + totalPages : '') + '...');
      const data = await gmGetJson(url);
      totalPages = data.total_pages || 1;
      for (const r of (data.results || [])) {
        rawCount++;
        if (r.id != null) {
          if (seenIds.has(r.id)) continue;
          seenIds.add(r.id);
        }
        const s = r.start_date, e = r.end_date || r.start_date;
        if (s && datesOverlap(s, e, range.start, range.end)) inRange.push(r);
      }
      page++;
      if (page <= totalPages) await wait(80);
    } while (page <= totalPages && page <= WHATSON_MAX_PAGES);
    if (page > WHATSON_MAX_PAGES && page <= totalPages) {
      vlog('WHAT\'S ON: hämtningen stoppades efter ' + WHATSON_MAX_PAGES + ' sidor (säkerhetsspärr) — fler event kan saknas.', 'err');
    }
    vlog('WHAT\'S ON: ' + rawCount + ' rader genomsökta över ' + (page - 1) + ' sida(or), ' + inRange.length + ' inom perioden.', 'ok');
    return inRange;
  }

  // Kategori → sektion. RÄTTAD 2026-09 mot en riktig körning på .se: API:et
  // returnerar lokaliserade SVENSKA kategorietiketter på den svenska domänen
  // ("musik", "scen & film", "utställningar" osv.), inte engelska slugs —
  // ursprungsgissningen (bara engelska nycklar) missade därför ALLA riktiga
  // träffar och allt hamnade i "Övrigt". Engelska nycklar behålls för .com.
  // Övriga kategorier (mässor, nätverkande, sport & hälsa, familj, m.fl.)
  // hör genuint inte hemma i någon av de 3 sektionerna och ska fortsätta
  // hamna i "Övrigt" — det är inte ett fel, bara gränsen för sidans struktur.
  const CATEGORY_TO_SECTION = {
    'music': 'concerts', 'musik': 'concerts', 'concerts': 'concerts', 'konserter': 'concerts',
    'festivals': 'concerts', 'festivaler': 'concerts',
    'stage-film': 'theatre', 'scen & film': 'theatre', 'stage': 'theatre', 'theatre': 'theatre',
    'teater': 'theatre', 'film': 'theatre',
    'exhibitions': 'museums', 'exhibition': 'museums', 'utställningar': 'museums',
    'museums': 'museums', 'museer': 'museums'
  };
  const SECTION_ORDER = ['concerts', 'theatre', 'museums', 'other'];
  const SECTION_LABELS = {
    concerts: 'Konserter & festivaler',
    theatre: 'Scen & film',
    museums: 'Museer & utställningar',
    other: 'Övrigt (okänd kategori)'
  };
  const MAX_EVENTS_PER_SECTION = 20;

  // De interna CMS-sidorna för "Biggest events"/"Opening soon"-guiderna.
  // Fungerar oavsett vilken domän man står på (bekräftat av Aron).
  const BIG_EVENTS_PAGE_IDS = [1298, 2353];
  const OPENING_SOON_PAGE_IDS = [4197, 4557];

  // En del kategorifält kan vara objekt (t.ex. {id, name}) istället för
  // rena strängar — bekräftat via en "[object Object]"-post i en riktig
  // körnings ej-mappade kategorier. Plockar ut ett rimligt namn-fält istället
  // för att bara String()-tvinga objektet till oanvändbar text.
  function categoryOf(ev) {
    const raw = [];
    if (ev.category) raw.push(ev.category);
    if (Array.isArray(ev.categories)) raw.push(...ev.categories);
    if (ev.subcategory) raw.push(ev.subcategory);
    return raw
      .map(c => (c && typeof c === 'object') ? (c.name || c.title || c.label || c.slug || '') : c)
      .filter(Boolean)
      .map(c => String(c).toLowerCase().trim());
  }

  function sectionForEvent(ev) {
    for (const c of categoryOf(ev)) {
      if (CATEGORY_TO_SECTION[c]) return CATEGORY_TO_SECTION[c];
    }
    return 'other';
  }

  // Matchar event mot guidernas innehåll via slug i /event/ eller /events/-
  // länkar — INTE via ett gissat fältnamn i guidens CMS-data, eftersom vi
  // inte känner till guidernas exakta fältstruktur. Vilken metod guiderna än
  // använder för att lista sina event (StreamField, relationsfält, manuella
  // länkar) landar de nästan säkert som en länk till eventets egen sida
  // någonstans i den hämtade HTML:en, så en bred slug-sökning över hela
  // sidan degraderar snyggt: ingen match = inga taggar, aldrig ett krasch.
  function extractEventSlugsFromHtml(html) {
    const slugs = new Set();
    const re = /\/events?\/([a-z0-9][a-z0-9-]*)/gi;
    let m;
    while ((m = re.exec(html || ''))) slugs.add(m[1].toLowerCase());
    return slugs;
  }

  function slugFromHref(href) {
    const m = /\/events?\/([a-z0-9][a-z0-9-]*)/i.exec(href || '');
    return m ? m[1].toLowerCase() : null;
  }

  async function fetchRelatedEventSlugsFromCmsPages(pageIds, label) {
    const slugs = new Set();
    for (const id of pageIds) {
      const url = 'https://www.visitstockholm.com/cms/pages/' + id + '/edit/';
      try {
        const html = await gmGet(url);
        const found = extractEventSlugsFromHtml(html);
        found.forEach(s => slugs.add(s));
        vlog(label + ': sida ' + id + ' — ' + found.size + ' event-slug(ar) hittade.');
      } catch (e) {
        vlog(label + ': kunde inte läsa sida ' + id + ' (' + e.message + ') — hoppar över, taggning blir ofullständig.', 'warn');
      }
    }
    return slugs;
  }

  function slimEvent(r) {
    return {
      id: r.id != null ? r.id : null,
      title: r.title || '',
      description: r.description || '',
      image: r.image || '',
      start_date: r.start_date || '',
      end_date: r.end_date || r.start_date || '',
      href: r.href || '',
      venue_name: r.venue_name || '',
      address: r.address || '',
      external_website_url: r.external_website_url || '',
      external_website_url_text: r.external_website_url_text || ''
    };
  }

  // Taggade event (Big Event/Opening Soon) räknas alltid med, UTÖVER taket
  // på MAX_EVENTS_PER_SECTION för resten — annars skulle ett tak kunna
  // trycka bort just de event som uttryckligen ska lyftas fram.
  function groupEventsIntoSections(events, tags) {
    const sections = { concerts: [], theatre: [], museums: [], other: [] };
    const unmappedCats = new Set();

    for (const ev of events) {
      const section = sectionForEvent(ev);
      if (section === 'other') categoryOf(ev).forEach(c => unmappedCats.add(c));

      const slug = slugFromHref(ev.href);
      const isBig = !!(slug && tags.big.has(slug));
      const isOpening = !!(slug && tags.opening.has(slug));
      sections[section].push(Object.assign(slimEvent(ev), { isBig, isOpening }));
    }

    if (unmappedCats.size) {
      vlog('WHAT\'S ON: ' + unmappedCats.size + ' okänd(a) kategori(er) hamnade i "Övrigt": ' + [...unmappedCats].join(', ') + ' — komplettera CATEGORY_TO_SECTION vid behov.', 'warn');
    }

    for (const key of Object.keys(sections)) {
      sections[key].sort((a, b) => {
        const aTag = (a.isBig || a.isOpening) ? 0 : 1;
        const bTag = (b.isBig || b.isOpening) ? 0 : 1;
        if (aTag !== bTag) return aTag - bTag;
        return (a.start_date || '').localeCompare(b.start_date || '');
      });
      const tagged = sections[key].filter(e => e.isBig || e.isOpening);
      const untagged = sections[key].filter(e => !e.isBig && !e.isOpening);
      const room = Math.max(0, MAX_EVENTS_PER_SECTION - tagged.length);
      sections[key] = tagged.concat(untagged.slice(0, room));
    }
    return sections;
  }

  function setWhatsOnStatus(msg, kind) {
    const s = document.getElementById('sb-whatson-status');
    if (s) {
      s.textContent = msg;
      s.className = 'sb-status ' + (kind || 'work');
      s.style.display = 'block';
    }
  }

  // Kryssrutorna är förikryssade ENDAST för taggade event (Big Event/
  // Opening Soon) — övriga event visas men väljs manuellt, precis som
  // specificerat ("förval av taggade event").
  // Separata grupper för taggade event (Biggest Events 🌟 / Opening Soon 🆕)
  // visas FÖR de ordinarie kategorisektionerna — Aron vill se dem uttryckligen
  // åtskilt från de kategorivisa listorna. Kryssrutorna bär samma
  // data-section/data-id som de ordinarie raderna, så skrivsteget hittar dem.
  function renderWhatsOnChecklist(sections) {
    const container = $('sb-whatson-checklist');
    if (!container) return;
    const eventRow = (key, ev, checked) => {
      const tagIcons = (ev.isBig ? '🌟 ' : '') + (ev.isOpening ? '🆕 ' : '');
      const dateRange = ev.end_date && ev.end_date !== ev.start_date
        ? esc(ev.start_date) + ' – ' + esc(ev.end_date)
        : esc(ev.start_date);
      return '<label class="sb-check sb-whatson-item">' +
        '<input type="checkbox" data-section="' + key + '" data-id="' + esc(String(ev.id)) + '"' +
        (checked ? ' checked' : '') + '>' +
        '<span>' + tagIcons + esc(ev.title) + ' <span class="sb-whatson-date">(' + dateRange + ')</span></span>' +
        '</label>';
    };

    const groups = [
      { title: '🌟 Biggest Events', list: [], checked: false, tags: e => e.isBig },
      { title: '🆕 Opening Soon',   list: [], checked: false, tags: e => e.isOpening }
    ];
    const seen = new Set();
    for (const key of SECTION_ORDER) {
      for (const ev of (sections[key] || [])) {
        for (const g of groups) {
          if (g.tags(ev) && !seen.has(g.title + '|' + ev.id)) {
            g.list.push({ key, ev });
            seen.add(g.title + '|' + ev.id);
          }
        }
      }
    }

    let html = '';
    let any = false;
    const section = (title, rowsHtml) =>
      '<div class="sb-whatson-collapsible">' +
      '<div class="sb-whatson-section-title">' +
      '<span class="sb-whatson-arrow">&#9662;</span>' + title + '</div>' +
      '<div class="sb-whatson-list">' + rowsHtml + '</div></div>';

    for (const g of groups) {
      if (!g.list.length) continue;
      any = true;
      const rows = g.list.map(({ key, ev }) => eventRow(key, ev, g.checked)).join('');
      html += section(g.title + ' (' + g.list.length + ')', rows);
    }

    for (const key of SECTION_ORDER) {
      const list = (sections[key] || []).filter(ev => !ev.isBig && !ev.isOpening);
      if (!list.length) continue;
      any = true;
      const rows = list.map(ev => eventRow(key, ev, false)).join('');
      html += section(esc(SECTION_LABELS[key]) + ' (' + list.length + ')', rows);
    }
    container.innerHTML = any ? html : '<div class="sb-status err" style="display:block;">Inga event hittades för vald period.</div>';
  }

  async function handleWhatsOnFetch() {
    if (busy) return;
    const monthValue = ($('sb-whatson-month') || {}).value;
    if (!monthValue) { setWhatsOnStatus('Välj en period först.', 'err'); return; }

    busy = true;
    $('sb-whatson-fetch').disabled = true;
    $('sb-whatson-checklist').innerHTML = '';
    $('sb-whatson-guides').innerHTML = '';

    try {
      const range = getWhatsOnPeriodRange(monthValue);
      vlog('WHAT\'S ON: period ' + range.start.toISOString().slice(0, 10) + ' t.o.m. (excl.) ' + range.end.toISOString().slice(0, 10));
      setWhatsOnStatus('Hämtar event från kalendern...', 'work');
      const events = await fetchCalendarEventsInRange(range);

      setWhatsOnStatus('Kontrollerar Biggest Events/Opening Soon-guiderna...', 'work');
      const [bigSlugs, openingSlugs] = await Promise.all([
        fetchRelatedEventSlugsFromCmsPages(BIG_EVENTS_PAGE_IDS, 'Biggest Events'),
        fetchRelatedEventSlugsFromCmsPages(OPENING_SOON_PAGE_IDS, 'Opening Soon')
      ]);

      const sections = groupEventsIntoSections(events, { big: bigSlugs, opening: openingSlugs });
      const guides = getSuggestedGuidesForRange(range);
      const cardBlocks = findExtendedRichTextBlocks().filter(b => b.type === 'card_image_link');
      const currentTitles = getCurrentCardLinkTitles(cardBlocks);
      whatsOnState = { monthValue, range, sections, guides, cardBlocks, currentTitles };
      renderWhatsOnChecklist(sections);
      renderWhatsOnGuideChecklist(guides, currentTitles);

      const total = SECTION_ORDER.reduce((n, k) => n + sections[k].length, 0);
      if (total === 0) {
        setWhatsOnStatus('Inga event hittades för vald period.', 'err');
      } else {
        setWhatsOnStatus('✅ ' + total + ' event hittade, ' + guides.length + ' guide(r) föreslagna — kryssa i/ur och fortsätt.', 'ok');
      }
    } catch (e) {
      vlog('WHAT\'S ON: fel — ' + e.message, 'err');
      setWhatsOnStatus('❌ ' + e.message, 'err');
    } finally {
      busy = false;
      $('sb-whatson-fetch').disabled = false;
    }
  }

  // ===== GUIDE-FÖRSLAG (card_image_link) =====
  // Månad → rekommenderade guider, enligt Arons tabell. sv: null betyder att
  // ingen svensk version av just den guiden finns ("ENDAST ENGELSKA" i
  // tabellen) — den guiden föreslås då aldrig på .se, bara på .com (EN).
  //
  // Denna sektion föreslår BARA titlar (kryssruteista, förikryssad — kurerad
  // lista, kryssa ur det som inte passar). Att slå upp varje vald titel mot en
  // verklig Wagtail-sida görs INTE här, utan i skrivsteget (steg 4) — då vet
  // vi exakt hur många card_image_link-block som ska läggas till och kan
  // öppna sidväljarens chooser-modal för varje guide i tur och ordning, med
  // samma sök-och-poängsätt-logik som epSelectInChooserModal/
  // calculateMatchScore redan använder för eventlänkar.
  const MONTH_GUIDES = {
    1: [
      { en: 'Winter Activities in Stockholm', sv: 'Vinteraktiviteter i Stockholm' },
      { en: 'Ice Skating in Stockholm', sv: 'Åk skridskor i Stockholm' },
      { en: 'Fun Sled Slopes in Stockholm', sv: 'Åk pulka i Stockholm' },
      { en: 'Brave the Cold: A Winter Swim in Stockholm', sv: 'Vinterbada i Stockholm' },
      { en: 'Find the Light in Winter Stockholm', sv: 'Hitta till ljuset i vintermörkret' }
    ],
    2: [
      { en: 'Have a Fun Winter Break in Stockholm', sv: 'Ha ett härligt sportlov i Stockholm' },
      { en: 'Fat Tuesday – the day of the Semla 2026', sv: 'Njut av Stockholms bästa semlor 2027' },
      { en: 'Roy Fares: My top 5 places to eat semla', sv: 'Roy Fares: Mina 5 bästa tips på semlor i Stockholm' },
      { en: 'Guide: Stockholm Design Week', sv: null },
      { en: 'Go Skiing in Stockholm!', sv: 'Skidåkning i Stockholm' }
    ],
    3: [
      { en: 'How to celebrate Ramadan in Stockholm as a visitor', sv: null },
      { en: 'Springtime in Stockholm', sv: null },
      { en: 'Springtime for Liljevalchs', sv: 'Nu våras det för Liljevalchs' }
    ],
    4: [
      { en: 'Easter in Stockholm', sv: 'Påsk i Stockholm 2026' },
      { en: 'A fika or lunch under the cherry blossoms', sv: 'Fika och luncha under körsbärsblommorna' },
      { en: 'Stockholm Culture Night 2026', sv: 'Kulturnatt Stockholm 2026' },
      { en: 'Walpurgis Night in Stockholm', sv: 'Fira valborg i Stockholm 2026' }
    ],
    5: [
      { en: 'Get the most out of Stockholm Marathon', sv: 'Maxa Stockholm Marathon' },
      { en: '4 great spots for an outdoor breakfast', sv: '4 fantastiska platser för en utomhusfrukost' },
      { en: 'An outdoor lunch or fika in Stockholm', sv: 'Fika och luncha utomhus i Stockholm' },
      { en: 'Sunny open-air restaurants', sv: 'Stockholms bästa uteserveringar' },
      { en: 'Green garden cafés in Stockholm', sv: 'Stockholms grönaste trädgårdskaféer' }
    ],
    6: [
      { en: 'Celebrate Sweden\'s National Day in Stockholm', sv: 'Här kan du fira Sveriges nationaldag i Stockholm 2026' },
      { en: 'Midsummer in Stockholm 2026', sv: 'Midsommar i Stockholm 2026' },
      { en: 'Best places to watch the FIFA World Cup in Stockholm', sv: 'Här ser du fotbolls-VM 2026 i Stockholm' },
      { en: 'Summer clubs', sv: 'Stockholms sommarklubbar' }
    ],
    7: [
      { en: 'Festival Summer in Stockholm', sv: 'Festivalsommar i Stockholm' },
      { en: 'Beaches in Stockholm: Swimming in the city', sv: 'Bada i Stockholm' },
      { en: 'Discover the Stockholm Archipelago', sv: 'Upptäck Stockholms skärgård' },
      { en: 'Have an Active Vacation', sv: 'Aktiv semester i Stockholm' },
      { en: 'The best ice cream in Stockholm 2026', sv: 'Hitta Stockholms bästa glass 2026' }
    ],
    8: [
      { en: 'It\'s time for crayfish!', sv: 'Dags för kräftor!' },
      { en: 'Celebrate Stockholm Pride 2026', sv: 'Här kan du fira Stockholm Pride 2026' },
      { en: 'Experience Finnkampen', sv: 'Fira Finnkampen 100 år' }
    ],
    9: [
      { en: 'Everything Around Lidingöloppet', sv: 'Allt runt Lidingöloppet' },
      { en: 'Treasures in the underbrush – foraging with Niki Sjöstrand', sv: null },
      { en: 'Hiking Trails Near Stockholm', sv: 'Vandring i och kring Stockholm' }
    ],
    10: [
      { en: 'Halloween and Fall break in Stockholm', sv: 'Hötslov i Stockholm 2026' },
      { en: 'The Haunting of Stockholm – Find the Spookiest Places in Town', sv: 'Fira Halloween i kusliga Stockholm' },
      { en: 'Stockholm on a Rainy Day', sv: 'En regnig dag i Stockholm' }
    ],
    11: [
      { en: 'At the Movies: Cinemas and Film Festivals Stockholm', sv: 'Mysiga biografer och filmfestivaler i Stockholm' },
      { en: 'Night at the Museum – Evening-open Attractions in Stockholm', sv: 'Kvällsöppna museer i Stockholm' },
      { en: 'Sauna in Stockholm', sv: 'Bada bastu i Stockholm' },
      { en: 'Enjoy a Spa Weekend in Stockholm City', sv: 'Njut av spa i Stockholm' }
    ],
    12: [
      { en: 'Lucia in Stockholm 2026', sv: 'Lucia i Stockholm 2026' },
      { en: 'Have a bite of Nobel cuisine', sv: 'En smak av Nobelmiddagen' },
      { en: 'Christmas Concerts and Events in Stockholm 2026', sv: 'Julkonserter och julshower i Stockholm 2026' },
      { en: 'Have a Great Christmas Holiday in Stockholm', sv: 'Jullov i Stockholm 2026 för hela familjen' },
      { en: 'New Year\'s Eve in Stockholm 2026', sv: 'Nyår i Stockholm 2026' }
    ]
  };

  // 1-indexerade månadsnummer som perioden [range.start, range.end) täcker.
  function getMonthsInRange(range) {
    const months = [];
    let d = new Date(range.start.getFullYear(), range.start.getMonth(), 1);
    while (d < range.end) {
      months.push(d.getMonth() + 1);
      d = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    }
    return months;
  }

  function getSuggestedGuidesForRange(range) {
    const sv = getWhatsOnLang() === 'sv';
    const seen = new Set();
    const guides = [];
    for (const month of getMonthsInRange(range)) {
      for (const g of (MONTH_GUIDES[month] || [])) {
        const title = sv ? g.sv : g.en;
        if (!title || seen.has(title)) continue;
        seen.add(title);
        guides.push({ title, month });
      }
    }
    return guides;
  }

  // Läser de BEFINTLIGA card_image_link-blockens sidtitlar ur DOM:en —
  // det dolda link-page-fältet bär bara sid-ID:t, men Wagtail renderar den
  // valda sidans titel som text bredvid väljarknappen, så vi söker uppåt i
  // DOM från fältet tills vi hittar en textknapp/länk med titelinnehåll.
  function getCurrentCardLinkTitles(cardBlocks) {
    const titles = [];
    for (const b of cardBlocks) {
      const fieldId = 'extended_rich_text-' + b.index + '-value-link-page';
      const field = document.getElementById(fieldId);
      if (!field) { titles.push(''); continue; }
      let el = field;
      let title = '';
      for (let i = 0; i < 8 && el && !title; i++) {
            const btn = el.querySelector && el.querySelector('[data-chooser-action-choose]');
            if (btn && btn.textContent && btn.textContent.trim()) title = btn.textContent.trim();
            el = el.parentElement;
          }
      titles.push(cleanDisplayText(title));
    }
    return titles;
  }

  // Två kolumner: befintliga kortlänkar (#1, #2, ...) till vänster med en
  // "byt ut mot..."-kryssruta per rad, månadens föreslagna guider till
  // höger med "ersätter vald sida"-kryssruta. Skrivsteget parar ihop den
  // ikryssade guiden med det ikryssade kortet (samma rad-index) och kör
  // sidväljaren mot just det blocket.
  function renderWhatsOnGuideChecklist(guides, currentTitles) {
    const container = $('sb-whatson-guides');
    if (!container) return;
    const titles = currentTitles || [];
    let html = '<div class="sb-whatson-section-title">Card image links — byt ut mot månadens guider</div>';
    html += '<div class="sb-whatson-guidegrid">';
    html += '<div class="sb-whatson-guidecol"><div class="sb-whatson-coltitle">Nuvarande länkar</div><div class="sb-whatson-list">';
    if (!titles.length) {
      html += '<div class="sb-whatson-date">Inga card_image_link-block hittades på sidan.</div>';
    }
    titles.forEach((t, i) => {
      html += '<label class="sb-check sb-whatson-item">' +
        '<input type="checkbox" class="sb-whatson-card-cb" data-card="' + i + '">' +
        '<span>#' + (i + 1) + ' ' + esc(t || '( Ingen sida vald)') + '</span>' +
        '</label>';
    });
    html += '</div></div>';
    html += '<div class="sb-whatson-guidecol"><div class="sb-whatson-coltitle">Föreslagna guider denna månaden</div><div class="sb-whatson-list">';
    if (!guides.length) {
      html += '<div class="sb-whatson-date">Inga guideförslag för perioden.</div>';
    }
    for (const g of guides) {
      html += '<label class="sb-check sb-whatson-item">' +
        '<input type="checkbox" class="sb-whatson-guide-cb" data-title="' + esc(g.title) + '" data-card="' + (g.card != null ? g.card : '') + '">' +
        '<span>' + esc(g.title) + ' <span class="sb-whatson-date">(ersätter vald sida)</span></span>' +
        '</label>';
    }
    html += '</div></div>';
    html += '</div>';
    container.innerHTML = html;
  }

  // ===== SKRIVSTEG (steg 4) =====
  // Skriver de ikryssade eventen/guiden till sidans BEFINTLIGA fact_box- och
  // card_image_link-block. FÖRSTA FÖRSÖKET — flera delar (särskilt
  // bildinfogningen) bygger på antaganden om Draftails DOM/klassnamn som
  // ännu inte är verifierade mot en riktig körning. Skriver ALDRIG till
  // fält den inte hittar — hoppar över och loggar istället, så ett
  // delvis misslyckande aldrig korrumperar resten av sidan.
  //
  // VIKTIGT: klickar INTE på "Spara utkast" automatiskt. Innehållet skrivs
  // in i de LEVANDE Draftail-editorerna så du kan GRANSKA det visuellt på
  // sidan innan du själv sparar — säkrare för ett första riktigt test än
  // att spara direkt och upptäcka fel efteråt.
  //
  // extended_rich_text-fältens fact_box/card_image_link-block är, precis
  // som rich_text/extra_info_text, LEVANDE Draftail-editorer (bekräftat av
  // att samma fält-ID:n dyker upp som både hidden-input OCH
  // richtext/contenteditable i fältkartläggningen) — att skriva en sträng
  // direkt till den dolda inputen skulle alltså tystas av editorns egen
  // React-state precis som i v4.16-buggen. Istället simuleras en RIKTIG
  // inklistring (paste) av HTML i editorn, så Draftails egen beprövade
  // HTML-till-block-konvertering bygger rubriker/punktlistor/fetstil/
  // kursiv/länkar korrekt via dess vanliga onChange-väg. Bilden infogas
  // separat via editorns egen "lägg till block → bild"-knapp och en RIKTIG
  // (inte bara sökande) bildväljar-interaktion, eftersom det är enda sättet
  // att referera en BEFINTLIG bild i bildbanken (id) utan att av misstag
  // ladda upp en ny — helt i linje med att scriptet ska välja bilder som
  // redan finns i CMS:ets bildbank, inte skapa nya.

  const SECTION_CONTENT_META = {
    concerts: {
      titleEn: 'Concerts', titleSv: 'Konserter',
      browseCategory: 'music',
      closingEn: 'Find more concerts in ', closingSv: 'Hitta fler konserter i ',
      closingLinkEn: 'our event calendar', closingLinkSv: 'vår evenemangskalender',
      keywords: ['concert', 'konsert', 'music', 'musik']
    },
    theatre: {
      titleEn: 'Theatre, opera & stage', titleSv: 'Teater, opera & scen',
      browseCategory: 'stage-film',
      closingEn: 'Find more shows in ', closingSv: 'Hitta fler föreställningar i ',
      closingLinkEn: 'our event calendar', closingLinkSv: 'vår evenemangskalender',
      keywords: ['theatre', 'teater', 'opera', 'stage', 'scen', 'film']
    },
    museums: {
      titleEn: 'Museum & Art highlights', titleSv: 'Museer & kulturupplevelser',
      browseCategory: 'exhibitions',
      closingEn: 'Discover more exhibitions in ', closingSv: 'Upptäck fler utställningar i ',
      closingLinkEn: 'our event calendar', closingLinkSv: 'vår evenemangskalender',
      keywords: ['museum', 'museer', 'exhibition', 'utställning', 'konst', 'art']
    }
  };

  function eventsBrowseBaseUrl(lang) {
    return (lang || getWhatsOnLang()) === 'sv' ? 'https://www.visitstockholm.se/event/' : 'https://www.visitstockholm.com/events/';
  }

  function formatEventDate(dateStr, lang) {
    const d = parseISODate(dateStr);
    if (!d) return dateStr || '';
    const names = lang === 'sv' ? MONTH_NAMES_SV : MONTH_NAMES_EN;
    return d.getDate() + ' ' + names[d.getMonth()];
  }

  function formatEventDateRange(ev, lang) {
    const start = formatEventDate(ev.start_date, lang);
    if (ev.end_date && ev.end_date !== ev.start_date) return start + '–' + formatEventDate(ev.end_date, lang);
    return start;
  }

  // API:ets description-fält är ofta en hel, ocurerad paragraf — de riktiga
  // exemplen Aron visade hade korta, handskrivna en-radsbeskrivningar (15–25
  // ord). Kortar av vid en ordgräns så punktlistans rader inte blir orimligt
  // långa tills en agent kan skriva om beskrivningarna istället.
  function truncateDescription(text, maxLen) {
    if (!text) return '';
    const clean = String(text).replace(/\s+/g, ' ').trim();
    if (clean.length <= maxLen) return clean;
    const cut = clean.slice(0, maxLen);
    const lastSpace = cut.lastIndexOf(' ');
    return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut) + '…';
  }

  // Läser vald sektion/id ur kryssrutorna i eventchecklistan och slår upp
  // hela event-objektet i whatsOnState (inte bara id:t) — "other"-sektionen
  // har ingen motsvarande plats på sidan och hopas alltid över.
  function getCheckedEventsBySection() {
    const result = { concerts: [], theatre: [], museums: [] };
    if (!whatsOnState) return result;
    document.querySelectorAll('#sb-whatson-checklist input[type="checkbox"][data-section]:checked').forEach(cb => {
      const section = cb.dataset.section;
      if (!result[section]) return;
      const ev = (whatsOnState.sections[section] || []).find(e => String(e.id) === cb.dataset.id);
      if (ev) result[section].push(ev);
    });
    return result;
  }

  // Parar ihop ikryssade guideförslag med ikryssade kort ("byt ut mot..." /
  // "ersätter vald sida"): första ikryssade guiden ersätter det första
  // ikryssade kortet, den andra det andra, osv. Fler guider än kort →
  // överskjutande guider ersätter det FÖRSTA kortet (standardbeteendet). Inget kort ikryssat → null = första card_image_link-blocket.
  function getCheckedGuideSelections() {
    const checkedCards = [...document.querySelectorAll('.sb-whatson-card-cb:checked')]
      .map(cb => parseInt(cb.dataset.card, 10)).sort((a, b) => a - b);
    const checkedGuides = [...document.querySelectorAll('.sb-whatson-guide-cb:checked')]
      .map(cb => cb.dataset.title);
    return checkedGuides.map((title, i) => ({
      title,
      card: checkedCards.length ? (checkedCards[i] != null ? checkedCards[i] : checkedCards[0]) : null
    }));
  }

  function findExtendedRichTextBlocks() {
    const countEl = document.querySelector('input[name="extended_rich_text-count"]');
    const count = countEl ? parseInt(countEl.value, 10) || 0 : 0;
    const blocks = [];
    for (let i = 0; i < count; i++) {
      const typeEl = document.querySelector('input[name="extended_rich_text-' + i + '-type"]');
      if (typeEl) blocks.push({ index: i, type: typeEl.value });
    }
    return blocks;
  }

  // Avgör vilken av de 3 sektionerna ett BEFINTLIGT fact_box-block hör till,
  // genom att läsa dess nuvarande rubrik (header-two-blocket) — INTE via
  // fast index, eftersom blockens ordning skiljer sig mellan .se/.com-
  // sidorna (bekräftat: Museer ligger FÖRST på .se-sidan, sist på .com).
  function classifyFactBoxSection(html) {
    let data;
    try { data = JSON.parse(html); } catch { return null; }
    const titleBlock = (data.blocks || []).find(b => b.type === 'header-two' && b.text && b.text.trim());
    const title = (titleBlock ? titleBlock.text : '').toLowerCase();
    for (const key of Object.keys(SECTION_CONTENT_META)) {
      if (SECTION_CONTENT_META[key].keywords.some(kw => title.includes(kw))) return key;
    }
    return null;
  }

  // Bygger HTML för en sektions innehåll, till inklistring i Draftail.
  // Den tomma inledande <p> lämnar plats åt bilden som infogas separat
  // (insertImageAtDraftailStart) — se motiveringen ovan till varför bilden
  // inte bara skrivs med i samma HTML.
  // ---- WHAT'S ON-AGENT: husstils-beskrivningar ----
  // Skickar de ikryssade eventen (id, titel, datum, råbeskrivning, sektion,
  // språk) till den dedikerade What's On-agenten och får tillbaka nyskrivna
  // 1–2-meningars beskrivningar i husstil som strikt JSON. Misslyckas
  // anropet (ingen nyckel/agent-ID, nätverksfel, ogiltigt svar) faller vi
  // tillbaka på truncateDescription så flödet aldrig blockeras.
  async function polishWhatsOnDescriptions(eventsBySection, lang) {
    const apiKey = ($('sb-mkey').value || GM_getValue('sidbot_mkey', '')).trim();
    const agentId = ($('sb-magent-whatson').value || GM_getValue('sidbot_magent_whatson', '')).trim();
    if (!apiKey || !agentId) {
      vlog("WHAT'S ON: ingen What's On-agent konfigurerad — använder API:ets råbeskrivningar (trunkerade).", 'warn');
      return false;
    }
    const all = [];
    for (const key of Object.keys(eventsBySection)) {
      for (const ev of eventsBySection[key]) {
        all.push({ id: String(ev.id), section: key, title: ev.title,
                   start_date: ev.start_date, end_date: ev.end_date,
                   url: ev.href, current_description: ev.description || '' });
      }
    }
    if (!all.length) return false;
    const payload = {
      page_language: lang === 'sv' ? 'svenska' : 'engelska',
      domain: lang === 'sv' ? 'visitstockholm.se' : 'visitstockholm.com',
      task: 'Skriv en beskrivning (1–2 meningar, 15–35 ord) per event i husstil på sidans språk. Behåll titlar och egennamn oförändrade. Fokusera på vad eventet är och varför det är värt att se — inga biljettpriser eller öppettider.',
      events: all
    };
    const agentInput = 'WHATSON-DESC-BATCH\n' + JSON.stringify(payload, null, 2) +
      '\nSvara ENBART med ett JSON-objekt på formen:' +
      '\n{"descriptions": [{"id": "<samma id som input>", "description": "<nyskriven beskrivning>"}]}' +
      '\nEtt objekt per input-event, samma id. Ingen extra text, inga kodblock.';
    try {
      setWhatsOnStatus('Agenten skriver beskrivningar (' + all.length + ' event)...', 'work');
      vlog("WHAT'S ON: skickar " + all.length + " event till What's On-agenten (" + agentId + ').');
      const data = await callMistralAgentForJSON(apiKey, agentId, agentInput, "what's on-beskrivningar");
      const list = Array.isArray(data?.descriptions) ? data.descriptions : [];
      let count = 0;
      for (const item of list) {
        if (!item || item.id == null || typeof item.description !== 'string' || !item.description.trim()) continue;
        for (const key of Object.keys(eventsBySection)) {
          const ev = eventsBySection[key].find(e => String(e.id) === String(item.id));
          if (ev) { ev.description = item.description.trim(); ev._polished = true; count++; break; }
        }
      }
      vlog("WHAT'S ON: " + count + '/' + all.length + ' beskrivningar mottagna från agenten.', count ? 'ok' : 'err');
      return count > 0;
    } catch (e) {
      vlog("WHAT'S ON: agent-anrop misslyckades (" + e.message + ') — använder råbeskrivningar.', 'warn');
      return false;
    }
  }
  function buildFactBoxSectionHtml(sectionKey, events, lang) {
    const meta = SECTION_CONTENT_META[sectionKey];
    const title = lang === 'sv' ? meta.titleSv : meta.titleEn;
    const closing = lang === 'sv' ? meta.closingSv : meta.closingEn;
    const closingLink = lang === 'sv' ? meta.closingLinkSv : meta.closingLinkEn;
    const browseUrl = eventsBrowseBaseUrl(lang) + '?categories=' + meta.browseCategory;

    let html = '<p><br></p><h2>' + esc(title) + '</h2><ul>';
    for (const ev of events) {
      const dateStr = formatEventDateRange(ev, lang);
      const desc = ev.description ? ' – ' + esc(ev._polished ? String(ev.description).replace(/\s+/g, ' ').trim() : truncateDescription(ev.description, 160)) : '';
      html += '<li><strong><a href="' + esc(ev.href) + '">' + esc(ev.title) + '</a></strong> ' +
        '<strong><em>' + esc(dateStr) + '</em></strong>' + desc + '</li>';
    }
    html += '</ul><p>' + esc(closing) + '<a href="' + esc(browseUrl) + '">' + esc(closingLink) + '</a></p>';
    return html;
  }

  // Simulerar en RIKTIG inklistring i en levande Draftail-editor, så
  // Draftails egen HTML-konvertering bygger rätt block/formatering — se
  // motiveringen i sektionsrubriken ovan. Markerar all befintlig text
  // (ersätts av inklistringen) innan paste-eventet skickas.
  async function pasteHtmlIntoDraftail(fieldId, html) {
    const root = await mountDraftail(fieldId);
    if (!root) { vlog('Draftail: hittade inget fält för ' + fieldId + ' — hoppar över.', 'err'); return false; }
    const editable = root.querySelector('[contenteditable="true"]') || root;
    editable.focus();
    const range = document.createRange();
    range.selectNodeContents(editable);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    await wait(100);

    let dt;
    try { dt = new DataTransfer(); } catch { dt = null; }
    if (!dt) { vlog('Draftail: DataTransfer stöds inte — kan inte klistra in i ' + fieldId + '.', 'err'); return false; }
    dt.setData('text/html', html);
    dt.setData('text/plain', html.replace(/<[^>]+>/g, ''));

    const pasteEvent = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, 'clipboardData', { value: dt });
    editable.dispatchEvent(pasteEvent);
    await wait(400);
    // Verifiera att paste faktiskt landade i editorns state — utan denna
    // kontroll returnerade funktionen alltid true, även om Draftail tyst
    // ignorerade paste-eventet (den troliga orsaken till att “Skriv till
    // sidan” kunde rapportera sektioner som skrivna utan att något syntes).
    const hidden = document.getElementById(fieldId);
    let hiddenText = '';
    try { hiddenText = readDraftailText(fieldId); } catch {}
    const got = hiddenText.replace(/\s+/g, ' ').trim();
    if (!got) {
      vlog('Draftail: paste till ' + fieldId + ' verkade ignoreras — dolt fält tomt efter paste. Provar execCommand-sätteväg.', 'warn');
      editable.focus();
      const r2 = document.createRange();
      r2.selectNodeContents(editable);
      const sel2 = window.getSelection();
      sel2.removeAllRanges();
      sel2.addRange(r2);
      if (document.execCommand('insertHTML', false, html)) {
        await wait(400);
        try { hiddenText = readDraftailText(fieldId); } catch {}
        vlog('Draftail: execCommand-insertHTML använd för ' + fieldId + (hiddenText ? ' — landade.' : ' — landade INTE heller.'), hiddenText ? 'ok' : 'err');
      }
    }
    const okPaste = got.length > 0 || (hiddenText || '').replace(/\s+/g, ' ').trim().length > 0;
    vlog('Draftail: ' + fieldId + ' efter paste: ' + (okPaste ? 'innehåll OK (' + (hiddenText || got).length + ' tecken)' : 'TOMT — paste togs inte emot'),
         okPaste ? 'ok' : 'err');
    return okPaste;
  }

  // Infogar en bild från BEFINTLIGA bildbanken (aldrig uppladdning av en ny)
  // längst upp i fältet, via editorns egen "lägg till block"-meny — precis
  // det gränssnitt en människa skulle använda ("skriver '/' och väljer
  // bild"). Icke-blockerande: misslyckas den, lämnas texten ändå kvar.
  async function insertImageAtDraftailStart(fieldId, searchTerm) {
    const root = await mountDraftail(fieldId);
    if (!root) return false;
    const editable = root.querySelector('[contenteditable="true"]') || root;
    editable.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.setStart(editable, 0);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    await wait(200);

    const trigger = root.querySelector('.Draftail-BlockToolbar__trigger');
    if (!trigger) { vlog('Draftail: hittade inte block-verktygsknappen — bild hoppas över för ' + fieldId + '.', 'warn'); return false; }
    trigger.click();
    await wait(300);

    const mediaBtn = document.querySelector('.MediaBlock[data-draftail-trigger]');
    if (!mediaBtn) { vlog('Draftail: hittade inte bild-knappen i blockmenyn — bild hoppas över för ' + fieldId + '.', 'warn'); return false; }
    mediaBtn.click();

    const modal = await waitForChooserModal(10000);
    if (!modal) { vlog('Draftail: bildväljaren öppnades inte — bild hoppas över för ' + fieldId + '.', 'warn'); return false; }
    let searchInput = modal.querySelector('input[type="text"], input[type="search"]');
    if (!searchInput) { await wait(500); searchInput = modal.querySelector('input[type="text"], input[type="search"]'); }
    if (!searchInput) { await closeChooserModal(); return false; }

    const cleanTerm = cleanDisplayText(searchTerm);
    const queryWords = cleanTerm.split(/\s+/).filter(Boolean);
    let searchQuery = queryWords.slice(0, 4).join(' ');
    if (queryWords.length > 1) searchQuery += ' ';
    searchInput.focus();
    setNativeInputValue(searchInput, searchQuery);
    searchInput.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: searchQuery.slice(-1) }));
    searchInput.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: searchQuery.slice(-1) }));
    await wait(900);

    const currentModal = getChooserModal();
    if (!currentModal) return false;
    const results = [...currentModal.querySelectorAll('[data-chooser-modal-choice]')]
      .filter(el => el.offsetParent !== null);
    if (!results.length) {
      vlog('Draftail: ingen bildträff i bildbanken för "' + searchTerm + '" — bild hoppas över.', 'warn');
      await closeChooserModal();
      return false;
    }
    const scored = results
      .map(el => ({ el, score: calculateMatchScore(el.textContent || el.getAttribute('title') || '', cleanTerm, el) }))
      .sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (!best || best.score < 400) {
      vlog('Draftail: ingen tillräckligt bra bildträff för "' + searchTerm + '" (bästa poäng ' + (best ? best.score : 0) + ') — bild hoppas över.', 'warn');
      await closeChooserModal();
      return false;
    }
    best.el.click();
    await wait(800);
    vlog('Draftail: bild infogad för "' + searchTerm + '" (poäng ' + best.score + ').', 'ok');
    return true;
  }

  // Hittar väljarknappen som hör ihop med ett dolt fält genom att gå uppåt
  // i DOM:en tills en gemensam förälder innehåller en chooser-knapp —
  // robustare än att gissa en fast CSS-väg, som skiljer sig mellan
  // fältgrupper.
  function findChooseButtonNear(fieldId) {
    const field = document.getElementById(fieldId);
    if (!field) return null;
    let el = field;
    for (let i = 0; i < 8 && el; i++) {
      const btn = el.querySelector && el.querySelector('[data-chooser-action-choose]');
      if (btn) return btn;
      el = el.parentElement;
    }
    return null;
  }

  // Generell chooser-sök-och-välj, som epSelectInChooserModal men utan
  // koppling till eventlistans specifika verifieringsfält — verifierar
  // istället att GODTYCKLIGT angivet fält faktiskt ändrat värde.
  async function genericSelectInChooserModal(chooseButton, searchTerm, verifyFieldId) {
    if (!chooseButton) return { ok: false, uncertain: false };
    const before = document.getElementById(verifyFieldId)?.value || '';
    chooseButton.click();
    const modal = await waitForChooserModal(10000);
    if (!modal) return { ok: false, uncertain: false };
    let searchInput = modal.querySelector('input[type="text"], input[type="search"]');
    if (!searchInput) { await wait(500); searchInput = modal.querySelector('input[type="text"], input[type="search"]'); }
    if (!searchInput) { await closeChooserModal(); return { ok: false, uncertain: false }; }

    const cleanTerm = cleanDisplayText(searchTerm);
    const queryWords = cleanTerm.split(/\s+/).filter(Boolean);
    let searchQuery = queryWords.slice(0, 4).join(' ');
    if (queryWords.length > 1) searchQuery += ' ';
    searchInput.focus();
    setNativeInputValue(searchInput, searchQuery);
    searchInput.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: searchQuery.slice(-1) }));
    searchInput.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: searchQuery.slice(-1) }));
    await wait(800);

    let lastBestKey = null, stableCount = 0;
    for (let attempt = 0; attempt < 40; attempt++) {
      await wait(300);
      const currentModal = getChooserModal();
      if (!currentModal) return { ok: false, uncertain: false };
      const choiceLinks = [...currentModal.querySelectorAll('[data-chooser-modal-choice]')]
        .filter(el => el.offsetParent !== null && el.textContent.trim().length > 0);
      if (choiceLinks.length === 0) continue;

      if (choiceLinks.length === 1) {
        choiceLinks[0].click();
        await wait(800);
        const after = document.getElementById(verifyFieldId)?.value || '';
        if (after && after !== before) { await closeChooserModal(); return { ok: true, uncertain: false }; }
        continue;
      }

      const scored = choiceLinks
        .map(el => ({ el, text: cleanDisplayText(el.textContent), score: calculateMatchScore(el.textContent, cleanTerm, el) }))
        .filter(h => h.score > 0)
        .sort((a, b) => b.score - a.score);
      if (!scored.length) continue;

      const best = scored[0], second = scored[1];
      const bestKey = best.text + '|' + best.score;
      if (bestKey === lastBestKey) stableCount++; else { stableCount = 0; lastBestKey = bestKey; }

      const excellent = best.score >= 900;
      const good = best.score > 700 && (!second || second.score < best.score - 100);
      const stabilized = stableCount >= 2 && (!second || best.score > second.score);
      if (excellent || good || stabilized) {
        best.el.click();
        await wait(800);
        const after = document.getElementById(verifyFieldId)?.value || '';
        if (after && after !== before) { await closeChooserModal(); return { ok: true, uncertain: !(excellent || good) }; }
      }
    }
    await closeChooserModal();
    return { ok: false, uncertain: false };
  }

  // Fyller i länken (link-page) på ett SPECIFIKT card_image_link-block (via
  // kortets position i StreamField-ordningen) — användaren väljer själv vilket
  // kort som ska bytas ut i guide-checklistan. Titel/text/bild på kortet
  // skrivs INTE här — det kräver säljande text, så du fyller i dem manuellt.
  async function fillGuideCard(guideTitle, cardIndex) {
    const blocks = findExtendedRichTextBlocks().filter(b => b.type === 'card_image_link');
    const cardBlock = (cardIndex != null && blocks[cardIndex]) ? blocks[cardIndex] : blocks[0];
    if (!cardBlock) { vlog('WHAT\'S ON: inget card_image_link-block hittat — guide-länken hoppas över.', 'warn'); return false; }

    const linkPageFieldId = 'extended_rich_text-' + cardBlock.index + '-value-link-page';
    const chooseBtn = findChooseButtonNear(linkPageFieldId);
    if (!chooseBtn) { vlog('WHAT\'S ON: hittade inte väljarknappen för guide-kortets länk.', 'err'); return false; }

    const result = await genericSelectInChooserModal(chooseBtn, guideTitle, linkPageFieldId);
    if (result.ok) {
      vlog('WHAT\'S ON: card_image_link #' + (cardIndex != null ? cardIndex + 1 : 1) + ' länk satt till "' + guideTitle + '"' + (result.uncertain ? ' (OSÄKER TRÄFF, dubbelkolla)' : ''), result.uncertain ? 'warn' : 'ok');
    } else {
      vlog('WHAT\'S ON: kunde inte hitta/välja sidan för guiden "' + guideTitle + '" — länken lämnas orörd.', 'err');
    }
    return result.ok;
  }

  async function handleWhatsOnWrite() {
    if (busy) return;
    if (!whatsOnState) { setWhatsOnStatus('Hämta event först.', 'err'); return; }

    const lang = getWhatsOnLang();
    const eventsBySection = getCheckedEventsBySection();
    const guideSelections = getCheckedGuideSelections();
    const anyEvents = Object.values(eventsBySection).some(list => list.length > 0);
    if (!anyEvents) { setWhatsOnStatus('Kryssa i minst ett event innan du skriver till sidan.', 'err'); return; }

    busy = true;
    $('sb-whatson-write').disabled = true;
    setWhatsOnStatus('Skriver till sidan...', 'work');

    try {
      await polishWhatsOnDescriptions(eventsBySection, lang);
      const blocks = findExtendedRichTextBlocks();
      let written = 0;

      for (const sectionKey of Object.keys(eventsBySection)) {
        const events = eventsBySection[sectionKey];
        if (!events.length) continue;

        const target = blocks.find(b => b.type === 'fact_box' &&
          classifyFactBoxSection($('extended_rich_text-' + b.index + '-value-html')?.value || '') === sectionKey);
        if (!target) {
          vlog('WHAT\'S ON: hittade inget befintligt fact_box-block för sektionen "' + sectionKey + '" — hoppar över (skapar inga nya block).', 'err');
          continue;
        }

        const fieldId = 'extended_rich_text-' + target.index + '-value-html';
        const html = buildFactBoxSectionHtml(sectionKey, events, lang);
        const ok = await pasteHtmlIntoDraftail(fieldId, html);
        if (!ok) { vlog('WHAT\'S ON: kunde inte skriva sektionen "' + sectionKey + '".', 'err'); continue; }

        written++;
        vlog('WHAT\'S ON: sektionen "' + sectionKey + '" skriven (' + events.length + ' event).', 'ok');
        try {
          await insertImageAtDraftailStart(fieldId, events[0].title);
        } catch (e) {
          vlog('WHAT\'S ON: bildinfogning för "' + sectionKey + '" misslyckades (' + e.message + ') — texten är ändå skriven.', 'warn');
        }
      }

      if (guideSelections.length > 0) {
        const usedCards = new Set();
        for (const sel of guideSelections) {
          let card = sel.card;
          if (card != null && usedCards.has(card)) {
            vlog('WHAT\'S ON: kort #' + (card + 1) + ' är redan ersatt — guiden "' + sel.title + '" hoppar över det kortet.', 'warn');
            card = null;
          }
          if (card != null) usedCards.add(card);
          await fillGuideCard(sel.title, card);
        }
      }

      setWhatsOnStatus(
        written > 0
          ? '✅ Skrivet till sidan (' + written + ' sektion(er)). Granska innehållet i editorn innan du sparar!'
          : '❌ Inget kunde skrivas — se loggen.',
        written > 0 ? 'ok' : 'err'
      );
    } catch (e) {
      vlog('WHAT\'S ON: fel vid skrivning — ' + e.message, 'err');
      setWhatsOnStatus('❌ ' + e.message, 'err');
    } finally {
      busy = false;
      $('sb-whatson-write').disabled = false;
    }
  }

  // ===== BILDAUTOMATION (alt-text via pixtral) =====
  // Samma bilduppladdningsmodal (Wagtails globala image-chooser) används av
  // både eventbot och EditorBot, så fält-ID:na nedan är identiska med
  // eventbots motsvarande modul. Skillnaden mot eventbot: här finns ingen
  // känd bild-URL att auto-hämta (objectpage-agenten returnerar ingen bild),
  // så bilden väljs manuellt av användaren precis som idag — scriptet
  // lyssnar bara på filfältets change-event och fyller i alt-text/kredit/
  // rättighetsdatum automatiskt när en fil väl har valts.
  const IMG_FIELDS = {
    title:       'id_image-chooser-upload-title',
    title_sv:    'id_image-chooser-upload-title_sv',
    description: 'id_image-chooser-upload-description',
    credit:      'id_image-chooser-upload-credit',
    credit_sv:   'id_image-chooser-upload-credit_sv',
    alt:         'id_image-chooser-upload-alt',
    alt_sv:      'id_image-chooser-upload-alt_sv',
    file:        'id_image-chooser-upload-file',
    rights:      'id_image-chooser-upload-rights_expiry_date'
  };

  // Object pages saknar ett naturligt slutdatum (till skillnad från event),
  // så rättighetsdatumet sätts till ett fast intervall: dagens datum + 5 år.
  function computeImageRightsExpiry() {
    const d = new Date();
    d.setFullYear(d.getFullYear() + 5);
    return d.toISOString().split('T')[0];
  }

  function fileToDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Kunde inte läsa bildfilen'));
      reader.readAsDataURL(file);
    });
  }

  // Separat, snabbt anrop till en RIKTIG synmodell (pixtral) enbart för
  // alt-text — huvudagenten (mistral-medium) ser inte bilder. Filen är
  // lokalt vald av användaren (inte hostad någonstans), så den skickas som
  // en data-URL istället för en bild-länk.
  // pixtral-12b-2409 är AVVECKLAT (deprec. 2025-12-02, ur drift 2025-12-31)
  // och API:t svarar direkt 404 "model not found" — därför "reverted" alt-
  // texten omedelbart till platshållaren. Nya synmodeller enligt Mistral:
  // ministral-14b-2512 (ersättaren), mistral-small-latest som reserv.
  const ALT_TEXT_MODELS = ['ministral-14b-2512', 'mistral-small-latest'];
  async function fetchAltTextFromImageFile(file, apiKey) {
    if (!file || !apiKey) return null;
    const dataUrl = await fileToDataURL(file);
    for (const model of ALT_TEXT_MODELS) {
      try {
        const body = {
          model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Beskriv bilden i EXAKT två korta, sakliga meningar. ' +
              'Svara ENBART med JSON: {"alttext_sv":"...","alttext_en":"..."}. ' +
              'Ingen text utanför JSON. Hitta inte på detaljer du inte ser.' },
            { type: 'image_url', image_url: dataUrl }
          ]
        }]
      };
        const resp = await gmPost('https://api.mistral.ai/v1/chat/completions',
          { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey }, body);
        const text = resp.choices?.[0]?.message?.content || '';
        const data = extractJSON(text);
        if (data && (data.alttext_sv || data.alttext_en)) {
          vlog('Alt-text genererad med modellen ' + model + '.', 'ok');
          return data;
        }
        vlog('Alt-text: modellen ' + model + ' svarade utan giltig JSON — provar nästa modell.', 'warn');
      } catch (e) {
        vlog('Alt-text-anrop (' + model + ') misslyckades: ' + e.message, 'err');
      }
    }
    return null;
  }

  // Sätter värdet via native-settern (som simulateInput/setNativeInputValue
  // på andra ställen i scriptet) OCH dispatchar både input och change —
  // Wagtails datumfält (rights_expiry_date) reagerar bara på change.
  function setImgFieldValue(el, value) {
    if (!el) return;
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Alt-text-fälten i uppladdningsmodalen är fysiskt små och visar inte hela
  // texten utan att man skrollar i sidled. Lägger därför en tillfällig
  // förhandsvisningsruta direkt under fältet med hela texten läsbar —
  // stängs manuellt (✕) eller ersätts av en ny ruta vid nästa bildval.
  function showAltTextPreview(fieldId, label, text) {
    const field = document.getElementById(fieldId);
    if (!field || !text) return;

    const existing = document.getElementById(fieldId + '-ep-preview');
    if (existing) existing.remove();

    const box = document.createElement('div');
    box.id = fieldId + '-ep-preview';
    box.style.cssText = 'margin-top:4px;padding:8px 28px 8px 10px;background:#fff8d6;' +
      'border:1px solid #e0c94a;border-radius:6px;font-size:12.5px;color:#3a3418;' +
      'line-height:1.4;white-space:pre-wrap;position:relative;max-width:100%;box-sizing:border-box;';
    box.innerHTML = '<strong>' + esc(label) + ':</strong> ' + esc(text) +
      '<button type="button" title="Stäng" style="position:absolute;top:4px;right:6px;' +
      'background:none;border:none;cursor:pointer;font-size:12px;color:#7a6d1a;padding:2px 4px;">✕</button>';
    box.querySelector('button').addEventListener('click', () => box.remove());

    field.insertAdjacentElement('afterend', box);
  }

  async function handleImageFileSelected(fileInput) {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;

    const apiKey = GM_getValue('sidbot_mkey', '').trim();
    if (!apiKey) {
      vlog('Bildautomation: ingen Mistral API-nyckel sparad (se ⚙️-fliken) — hoppar över alt-text.', 'warn');
      return;
    }

    const pageTitle = (document.getElementById('id_title')?.value || '').trim();
    vlog('Bild vald (' + file.name + ') — genererar alt-text via pixtral…');

    const alt = await fetchAltTextFromImageFile(file, apiKey);
    const placeholder = pageTitle ? ('Bild: ' + pageTitle) : 'Bild';
    const altSv = (alt && alt.alttext_sv) || placeholder;
    const altEn = (alt && alt.alttext_en) || placeholder;
    vlog(alt ? 'Pixtral gav alt-text.' : 'Pixtral gav ingen alt-text — använder platshållare.', alt ? 'ok' : 'warn');

    const map = [
      [IMG_FIELDS.title,       pageTitle],
      [IMG_FIELDS.title_sv,    pageTitle],
      [IMG_FIELDS.description, altSv],
      [IMG_FIELDS.credit,      pageTitle ? ('Press image ' + pageTitle) : 'Press image'],
      [IMG_FIELDS.credit_sv,   pageTitle ? ('Pressbild ' + pageTitle) : 'Pressbild'],
      [IMG_FIELDS.alt,         altEn],
      [IMG_FIELDS.alt_sv,      altSv],
      [IMG_FIELDS.rights,      computeImageRightsExpiry()]
    ];
    let filled = 0;
    for (const [id, val] of map) {
      const el = document.getElementById(id);
      if (!el) continue;
      if (val) { setImgFieldValue(el, val); filled++; }
    }
    vlog('Bildfält ifyllda: ' + filled + ' st.', 'ok');

    // Alt-text-fälten är för smala för att visa hela texten — lägg en
    // läsbar förhandsvisning direkt under dem så man slipper skrolla i sidled.
    showAltTextPreview(IMG_FIELDS.alt, 'Alt-text (EN)', altEn);
    showAltTextPreview(IMG_FIELDS.alt_sv, 'Alt-text (SV)', altSv);
  }

  // Delegerad, fångstfas-lyssnare på documentet — bilduppladdningsmodalen
  // skapas/tas bort dynamiskt av Wagtail, så en direkt lyssnare på filfältet
  // skulle tappas mellan öppningar. Fångar alla tre bildväljare på sidan
  // (featured_image, og_image, twitter_image) eftersom de delar samma
  // modal och därmed samma fält-ID:n.
  document.addEventListener('change', (e) => {
    if (e.target && e.target.id === IMG_FIELDS.file) {
      handleImageFileSelected(e.target).catch(err => vlog('Bildautomation fel: ' + err.message, 'err'));
    }
  }, true);

  // ===== TOPPRAD I BILDVYN ("Editorbot – bildhantering") =====
  // Samma design som ep-bar, men visas ENDAST medan bilduppladdningsmodalen
  // är öppen (dvs. när filfältet finns i DOM:en). Loggknappen öppnar en
  // loggruta (samma VLOG som övriga widgetar via renderLog) och kugghjulet
  // öppnar en inställningsvy som läser/skriver EXAKT samma GM-nycklar som
  // panelens ⚙️-flik — så man kan bekräfta att API-nyckel/agent-ID har
  // synkats direkt i bildvyn, oavsett vilken sida man står på.
  const IMG_BAR_SETTINGS_FIELDS = [
    { key: 'sidbot_mkey',           label: 'Mistral API-nyckel' },
    { key: 'sidbot_magent',         label: 'Mistral agent-ID' },
    { key: 'sidbot_magent_whatson', label: "What's On agent-ID" },
    { key: 'sidbot_calendar_api',   label: 'Kalender-API (override)' }
  ];
  function buildImageHandlingBar() {
    if (document.getElementById('ep-img-bar')) return;
    const style = document.createElement('style');
    style.id = 'ep-img-style';
    style.textContent = `
      #ep-img-bar { position: fixed !important; top: 0 !important; left: 0 !important; right: 0 !important;
        z-index: 2147483000 !important; background: var(--vd-bg); border-bottom: 2px solid var(--vd-accent);
        box-shadow: 0 4px 20px rgba(0,0,0,.4); display: none; align-items: center; gap: 8px;
        padding: 8px 12px; font-family: system-ui, sans-serif; color: var(--vd-txt); font-size: 13px; }
      #ep-img-bar .ep-title { font-weight: 700; white-space: nowrap; }
      #ep-img-bar .ep-g { flex: 1; }
      #ep-img-bar button { background: var(--vd-bg2); border: 1px solid var(--vd-line); color: var(--vd-txt);
        border-radius: 5px; padding: 6px 10px; font-size: 12px; font-weight: 600; cursor: pointer; white-space: nowrap; }
      #ep-img-bar button:hover { background: var(--vd-bg3); }
      #ep-img-logwrap { display: none; position: fixed !important; top: 42px !important; left: 10px !important;
        z-index: 2147483001 !important; width: 500px; max-height: 70vh; background: var(--vd-bg2);
        border: 1px solid var(--vd-line); border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,.6);
        overflow: hidden; resize: both; font-family: system-ui, sans-serif; }
      #ep-img-logwrap #ep-img-log { height: calc(70vh - 42px); max-height: calc(70vh - 42px); overflow-y: auto; padding: 8px 10px; background: var(--vd-bg); font-size: 11.5px; }
      #ep-img-log .sb-logline { color: var(--vd-txt2); padding: 1px 0; }
      #ep-img-log .sb-logline.ok { color: #7fd48a; }
      #ep-img-log .sb-logline.warn { color: #e8c66a; }
      #ep-img-log .sb-logline.err { color: #ff8080; }
      #ep-img-setwrap { display: none; position: fixed !important; top: 42px !important; left: 10px !important;
        z-index: 2147483001 !important; width: 420px; background: var(--vd-bg2); border: 1px solid var(--vd-line);
        border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,.6); padding: 10px 12px;
        font-family: system-ui, sans-serif; color: var(--vd-txt); font-size: 12px; }
      #ep-img-setwrap .ep-img-settitle { font-weight: 700; margin-bottom: 6px; display: flex; justify-content: space-between; }
      #ep-img-setwrap button { background: var(--vd-bg3); border: 1px solid var(--vd-line); color: var(--vd-txt);
        border-radius: 5px; padding: 2px 8px; font-size: 11px; cursor: pointer; }
      #ep-img-setwrap label { display: block; margin: 6px 0 2px; color: var(--vd-txt2); font-size: 11px; }
      #ep-img-setwrap input { width: 100%; box-sizing: border-box; background: var(--vd-bg); color: var(--vd-txt);
        border: 1px solid var(--vd-line); border-radius: 5px; padding: 5px 8px; font-size: 12px; }
    `;
    document.head.appendChild(style);

    const bar = document.createElement('div');
    bar.id = 'ep-img-bar';
    bar.innerHTML =
      '<span class="ep-title">Editorbot – bildhantering</span>' + versionBadgeHTML() +
      '<span class="ep-g"></span>' +
      '<button type="button" id="ep-img-logbtn" title="Visa logg">📋 Logg</button>' +
      '<button type="button" id="ep-img-setbtn" title="Inställningar">⚙️</button>';
    document.body.appendChild(bar);

    const logWrap = document.createElement('div');
    logWrap.id = 'ep-img-logwrap';
    logWrap.innerHTML =
      '<div id="ep-img-loghdr" style="display:flex;justify-content:space-between;align-items:center;padding:6px 10px;border-bottom:1px solid var(--vd-line);">' +
      '<span style="font-weight:700;font-size:12px;">Logg</span>' +
      '<button type="button" id="ep-img-logclose">✕</button></div>' +
      '<div id="ep-img-log"></div>';
    document.body.appendChild(logWrap);

    const setWrap = document.createElement('div');
    setWrap.id = 'ep-img-setwrap';
    setWrap.innerHTML =
      '<div class="ep-img-settitle"><span>Inställningar</span><button type="button" id="ep-img-setclose">✕</button></div>' +
      IMG_BAR_SETTINGS_FIELDS.map(f =>
        '<label>' + esc(f.label) + '</label>' +
        '<input type="text" data-gmkey="' + esc(f.key) + '" autocomplete="off" spellcheck="false">'
      ).join('') +
      '<div style="margin-top:8px;color:var(--vd-txt3);font-size:10.5px;">Samma värden som panelens ⚙️-flik — ändringar sparas direkt.</div>';
    document.body.appendChild(setWrap);

    setWrap.querySelectorAll('input[data-gmkey]').forEach(inp => {
      const key = inp.dataset.gmkey;
      inp.value = GM_getValue(key, '');
      inp.addEventListener('change', () => {
        GM_setValue(key, inp.value.trim());
        const panelFieldMap = { sidbot_mkey: 'sb-mkey', sidbot_magent: 'sb-magent', sidbot_magent_whatson: 'sb-magent-whatson', sidbot_calendar_api: 'sb-calendar-api' };
        const panelField = document.getElementById(panelFieldMap[key] || '');
        if (panelField) panelField.value = inp.value.trim();
        vlog('Bildhantering: ' + key + ' sparad.');
      });
    });

    document.getElementById('ep-img-logbtn').addEventListener('click', () => {
      setWrap.style.display = 'none';
      logWrap.style.display = logWrap.style.display === 'block' ? 'none' : 'block';
      renderLog();
    });
    document.getElementById('ep-img-logclose').addEventListener('click', () => { logWrap.style.display = 'none'; });
    document.getElementById('ep-img-setbtn').addEventListener('click', () => {
      logWrap.style.display = 'none';
      if (setWrap.style.display === 'block') { setWrap.style.display = 'none'; return; }
      setWrap.querySelectorAll('input[data-gmkey]').forEach(inp => { inp.value = GM_getValue(inp.dataset.gmkey, ''); });
      setWrap.style.display = 'block';
    });
    document.getElementById('ep-img-setclose').addEventListener('click', () => { setWrap.style.display = 'none'; });

    // Visa/följ toppraden bara medan bilduppladdningsmodalen lever i DOM:en.
    const sync = () => {
      const open = !!document.getElementById(IMG_FIELDS.file);
      bar.style.display = open ? 'flex' : 'none';
      if (!open) { logWrap.style.display = 'none'; setWrap.style.display = 'none'; }
    };
    new MutationObserver(sync).observe(document.body, { childList: true, subtree: true });
    sync();
  }

  function vlog(msg, kind = 'info') {
    const t = new Date();
    const hhmmss = String(t.getHours()).padStart(2,'0') + ':' +
                   String(t.getMinutes()).padStart(2,'0') + ':' +
                   String(t.getSeconds()).padStart(2,'0');
    const line = '[' + hhmmss + '] ' + msg;
    VLOG.push({ line, kind });
    if (VLOG.length > 500) VLOG.shift();
    console.log('SIDBOT ' + line);
    renderLog();
  }

  function renderLog() {
    const epLog = document.getElementById('ep-log');
    const sbLog = document.getElementById('sb-log');
    const imgLog = document.getElementById('ep-img-log');
    if (!epLog && !sbLog && !imgLog) return;
    const logContent = VLOG.map(e => `<div class="sb-logline ${e.kind}">${esc(e.line)}</div>`).join('');
    if (epLog) epLog.innerHTML = logContent;
    if (sbLog) sbLog.innerHTML = logContent;
    if (imgLog) imgLog.innerHTML = logContent;
    if (epLog) epLog.scrollTop = epLog.scrollHeight;
    if (sbLog) sbLog.scrollTop = sbLog.scrollHeight;
    if (imgLog) imgLog.scrollTop = imgLog.scrollHeight;
  }

  function esc(s) { return s == null ? '' : String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
  const $ = id => document.getElementById(id);
  const wait = ms => new Promise(r => setTimeout(r, ms));

  function simulateInput(el, value) {
    if (!el) return false;
    if (el.type === 'checkbox') el.checked = value === 'true' || value === true;
    else el.value = value || '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
    return true;
  }

  // React (och andra ramverk som styr sina fält) skriver över inputens
  // nativa "value"-setter, så el.value = ... följt av dispatchEvent(Event)
  // ovan når aldrig fram till reglaget — fältet SER ifyllt ut i DOM:en men
  // ramverket vet inte om det och triggar aldrig sin sökning. Detta sätter
  // värdet via den underliggande native-settern precis som en riktig
  // knapptryckning skulle göra, vilket React fångar upp korrekt.
  function setNativeInputValue(el, value) {
    if (!el) return false;
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  // ===== DRAFTAIL (rich_text/extra_info_text) — läsa och skriva korrekt =====
  // Wagtails Draftail-fält (rich_text, extra_info_text) är INTE vanliga
  // textfält: det synliga fältet är en React/Draft.js-editor, och det dolda
  // <input>:et (id_rich_text etc.) innehåller Draft.js egen
  // JSON-serialisering av innehållet ({"blocks":[...],...}), inte klartext.
  // Att skriva en vanlig sträng dit med simulateInput uppdaterar bara det
  // dolda fältet, aldrig den synliga editorn eller Draft.js interna state
  // — porterat rakt av från eventbot, som redan har detta beprövat.
  function readDraftailText(fieldId) {
    const hidden = document.getElementById(fieldId);
    if (!hidden || !hidden.value) return '';
    try { return (JSON.parse(hidden.value).blocks || []).map(b => b.text || '').join('\n'); }
    catch { return ''; }
  }

  async function mountDraftail(fieldId) {
    const hidden = document.getElementById(fieldId);
    if (!hidden) return null;
    const wrapper = hidden.closest('.w-field, .w-panel, [data-field]') || hidden.parentElement;
    const findRoot = () =>
      wrapper?.querySelector('.DraftEditor-root') ||
      wrapper?.querySelector('.Draftail-Editor .DraftEditor-root');
    let root = findRoot();
    if (!root) {
      hidden.scrollIntoView({ block: 'center' });
      const clickTarget = wrapper?.querySelector('.Draftail-Editor') || wrapper || hidden;
      clickTarget.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      clickTarget.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      clickTarget.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      for (let i = 0; i < 40 && !root; i++) {
        await wait(75);
        root = findRoot();
      }
    }
    return root || null;
  }

  function draftPropsDebugInfo(root, hops) {
    try {
      const keys = Object.keys(root);
      const fiber = keys.filter(k => k.startsWith('__reactInternalInstance$') || k.startsWith('__reactFiber$'));
      const rprops = keys.filter(k => k.startsWith('__reactProps$'));
      const propsDetail = rprops.map(k => {
        const p = root[k];
        return k + '(' + (p ? ['onChange', 'editorState'].filter(f => p[f]).join('+') || 'varken onChange eller editorState' : 'null') + ')';
      }).join(', ') || 'inga';
      return 'root-nycklar: ' + keys.length +
        ', fiber: ' + (fiber.join(', ') || 'INGA (__reactInternalInstance$/__reactFiber$)') +
        ', hops vandrade: ' + hops +
        ', __reactProps$: ' + propsDetail +
        ', klass: ' + (root.className || root.nodeName);
    } catch (e) { return 'debug-info misslyckades: ' + (e && e.message); }
  }
  function getDraftProps(root) {
    const instKey = Object.keys(root).find(k => k.startsWith('__reactInternalInstance$') || k.startsWith('__reactFiber$'));
    let node = instKey ? root[instKey] : null;
    let hops = 0;
    while (node && hops < 30) {
      const mp = node.memoizedProps;
      if (mp && mp.onChange && mp.editorState) return mp;
      node = node.return || node._debugOwner || null;
      hops++;
    }
    const propsKey = Object.keys(root).find(k => k.startsWith('__reactProps$'));
    if (propsKey) {
      const candidates = Object.keys(root).filter(k => k.startsWith('__reactProps$')).map(k => root[k]);
      for (const p of candidates) {
        if (p && p.onChange && p.editorState) return p;
      }
    }
    window.__sbDraftailDebug = draftPropsDebugInfo(root, hops);
    return null;
  }

  // Paste-reserv när React-props saknas (portrerad från EventBot v7.97.9):
  // vissa sidor exponerar aldrig __reactFiber$/__reactProps$ på .DraftEditor-root
  // ("root-nycklar: 0" i loggen), så props-vandringen är en återvändsgränd —
  // då skrivs texten UTAN React-props i stället, en metod i taget med
  // verifiering mot det dolda input-fältet mellan varje steg.
  const draftailNorm = t => String(t || '').replace(/\s+/g, ' ').trim();

  // Draft.js är en kontrollerad komponent: DOM-ändringar React inte sanktionerat
  // accepteras till synes men kastas bort vid nästa tangenttryckning. Därför
  // verifieras varje metod mot det DOLDA input-fältet (draft.js-JSON) — aldrig
  // mot DOM:en. Synken till det dolda fältet kan dröja, därför pollas det.
  async function draftailTextLanded(fieldId, text) {
    const want = draftailNorm(text);
    for (let i = 0; i < 15; i++) {
      if (draftailNorm(readDraftailText(fieldId)) === want) return true;
      await wait(100);
    }
    return draftailNorm(readDraftailText(fieldId)) === want;
  }

  async function updateDraftailViaClipboard(fieldId, text) {
    const hidden = document.getElementById(fieldId);
    const root = await mountDraftail(fieldId);
    if (!root) return false;
    const surface = root.querySelector('.public-DraftEditor-content') || root;

    // Metod 1 — riktig paste-händelse: går genom Draftails egen paste-hantering
    // som uppdaterar React-state korrekt, därför först.
    try {
      if (!surface.isContentEditable) return false;
      surface.focus();
      const dt = new DataTransfer();
      dt.setData('text/plain', String(text));
      surface.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    } catch (err) {
      vlog('Draftail: paste-händelse misslyckades för ' + fieldId + ': ' + (err && err.message ? err.message : err), 'warn');
    }
    if (await draftailTextLanded(fieldId, text)) {
      vlog('Draftail: ' + fieldId + ' ifyllt via paste-händelse.', 'ok');
      return true;
    }

    // Metod 2 — execCommand: ersätter markerat innehåll i den fokuserade ytan
    // när paste inte landat; kräver att ytan faktiskt är fokuserad.
    try {
      surface.focus();
      document.execCommand('selectAll');
      document.execCommand('insertText', false, String(text));
    } catch (err) {
      vlog('Draftail: execCommand misslyckades för ' + fieldId + ': ' + (err && err.message ? err.message : err), 'warn');
    }
    if (await draftailTextLanded(fieldId, text)) {
      vlog('Draftail: ' + fieldId + ' ifyllt via execCommand.', 'ok');
      return true;
    }

    // Metod 3 — sista reserv: Draft.js-JSON direkt i det dolda input-fältet.
    // Fältet kan bli svårt att redigera vid nästa tangenttryckning, men ett
    // ifyllt fält är bättre än ett tomt.
    if (hidden) {
      try {
        hidden.value = JSON.stringify({ blocks: [{ key: 'sb0', text: String(text), type: 'unstyled', depth: 0, inlineStyleRanges: [], entityRanges: [], data: {} }], entityMap: {} });
        hidden.dispatchEvent(new Event('input', { bubbles: true }));
        hidden.dispatchEvent(new Event('change', { bubbles: true }));
      } catch (err) {
        vlog('Draftail: kunde inte skriva dolt input-fält för ' + fieldId + ': ' + (err && err.message ? err.message : err), 'warn');
      }
      if (await draftailTextLanded(fieldId, text)) {
        vlog('Draftail: ' + fieldId + ' ifyllt via dolt input-fält — fältet kan behöva redigeras efter sparning.', 'warn');
        return true;
      }
    }

    vlog('Draftail: paste-reserv misslyckades för ' + fieldId + ' — fältet lämnas orört. [' +
         (window.__sbDraftailDebug || 'ingen debug-info') + ']', 'err');
    return false;
  }

  async function updateDraftail(fieldId, text) {
    try {
      const root = await mountDraftail(fieldId);
      if (!root) {
        vlog('Draftail: hittade inget rich text-fält för ' + fieldId + ' — fältet lämnas orört.', 'err');
        return false;
      }
      const props = getDraftProps(root);
      if (!props) {
        vlog('Draftail: hittade fältet ' + fieldId + ' men inte dess React-props — provar paste-reserv. [' +
             (window.__sbDraftailDebug || 'ingen debug-info') + ']', 'warn');
        return await updateDraftailViaClipboard(fieldId, text);
      }
      const editorState = props.editorState;
      const EditorState = editorState.constructor;
      const currentContent = editorState.getCurrentContent();
      const ContentState = currentContent.constructor;
      const newContent = ContentState.createFromText(String(text), '\n');
      let newState = EditorState.createWithContent(newContent);
      if (typeof EditorState.moveSelectionToEnd === 'function') newState = EditorState.moveSelectionToEnd(newState);
      props.onChange(newState);
      return true;
    } catch (err) {
      vlog('Draftail: fel vid ifyllning av ' + fieldId + ': ' + (err && err.message ? err.message : err), 'err');
      return false;
    }
  }

  // Kända icke-resultat i chooser-modalen (bläddringsknappar m.m.) som ALDRIG
  // ska räknas som sökträffar, oavsett poäng — annars kan de dominera
  // poängsättningen när de riktiga sökträffarna av någon anledning inte laddas.
  const CHOOSER_IGNORE_TEXTS = new Set([
    'föregående', 'nästa', 'previous', 'next', 'sök', 'search',
    'visa fler', 'show more', 'stäng', 'close', 'avbryt', 'cancel'
  ]);

  // ===== FÖRBÄTTRAD TEXTRENSNING =====
  function cleanDisplayText(text) {
    if (!text) return '';
    return text
      .replace(/\*/g, '')  // Ta bort *
      .replace(/\s+/g, ' ')  // Normalisera blanksteg
      .replace(/^\s+|\s+$/g, '')  // Trim
      .replace(/–/g, '-')  // Em-dash till bindestreck
      .replace(/[\"'\u2018\u2019\u201c\u201d]/g, '')  // Ta bort citattecken
      .replace(/[\/]+/g, '/')  // Normalisera slashar
      .replace(/-/g, ' ')  // Byt bindestreck till blanksteg för bättre matchning
      .substring(0, 200);
  }

  // ===== FÖRBÄTTRAD MATCHNINGSFUNKTION =====
  function calculateMatchScore(elementText, searchTerm, element) {
    const cleanElText = cleanDisplayText(elementText);
    const cleanSearch = cleanDisplayText(searchTerm);

    // 1. EXAKT MATCHNING (högsta prioritet)
    if (cleanElText === cleanSearch) {
      return 1000;
    }

    // 2. EXAKT MATCHNING MED ORIGINAL TEXT (om clean misslyckas)
    if (elementText.trim() === searchTerm.trim()) {
      return 990;
    }

    // 3. HEL SÖKTERM INNEHÅLLEN (mycket stark match)
    if (cleanElText.toLowerCase().includes(cleanSearch.toLowerCase())) {
      const lengthDiff = Math.abs(cleanElText.length - cleanSearch.length);
      // Straffa för stor längdskillnad
      return 900 - (lengthDiff * 2);
    }

    // 4. DELSTRÄNGSMATCHNING - MER NOGGRANN
    const searchWords = cleanSearch.toLowerCase().split(/\s+\//);
    const elWords = cleanElText.toLowerCase().split(/\s+\//);

    let wordMatches = 0;
    let consecutiveMatches = 0;
    let maxConsecutive = 0;

    for (let i = 0; i < searchWords.length && i < elWords.length; i++) {
      if (elWords[i].includes(searchWords[i])) {
        wordMatches++;
        consecutiveMatches++;
        maxConsecutive = Math.max(maxConsecutive, consecutiveMatches);
      } else {
        consecutiveMatches = 0;
      }
    }

    // Poäng baserat på ordmatchningar
    const wordScore = wordMatches * 50;
    const consecutiveScore = maxConsecutive * 30;

    // 5. LÄNGDSBASERAD POÄNG
    const lengthSimilarity = 100 - Math.abs(cleanElText.length - cleanSearch.length);

    // 6. TAG-BONUS
    const tagBonus = element.tagName === 'A' ? 20 : 0;

    // 7. CHOOSER-ATTRIBUT BONUS
    const chooserBonus = element.hasAttribute('data-chooser-action-choose') ? 30 : 0;

    // Totalt poäng
    return wordScore + consecutiveScore + lengthSimilarity + tagBonus + chooserBonus;
  }

  // ===== MODAL HANTERING =====
  function getChooserModal() {
    const candidates = document.querySelectorAll('.w-modal, [role="dialog"], .modal, .chooser-modal, .w-chooser, .modal-dialog, .dialog');
    for (const modal of candidates) {
      if (modal.id && (modal.id.includes('overwrite') || modal.id.includes('confirm') || modal.id.includes('alert'))) {
        continue;
      }
      const style = window.getComputedStyle(modal);
      if (style.display === 'none' || style.visibility === 'hidden') {
        continue;
      }
      const searchInput = modal.querySelector('input[type="text"], input[type="search"], .chooser__search-input');
      if (searchInput) {
        return modal;
      }
    }
    return null;
  }

  async function waitForChooserModal(timeout = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const modal = getChooserModal();
      if (modal) return modal;
      await wait(300);
    }
    return null;
  }

  async function closeChooserModal() {
    const modal = getChooserModal();
    if (modal) {
      const closeBtn = modal.querySelector('.w-dialog__close-button, [data-action*="hide"], [aria-label*="Stäng"], button.close');
      if (closeBtn) {
        closeBtn.click();
        await wait(500);
        return true;
      }
      const overlay = modal.querySelector('.w-dialog__overlay, .modal-backdrop, .overlay');
      if (overlay) {
        overlay.click();
        await wait(500);
        return true;
      }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await wait(500);
      return true;
    }
    return false;
  }

  // ===== EVENTPORTÖR =====
  // Extraherar sidans ID ur en /cms/pages/<id>/edit/-url. Används istället för
  // path.includes(id) på egen hand, eftersom ett kort numeriskt ID (t.ex. "7"
  // för S&D) annars råkar matcha som delsträng i helt andra siffror i
  // sökvägen (t.ex. "1474" i /objectpage/1474/ innehåller "7").
  function epPageIdFromPath(path) {
    const m = path.match(/\/cms\/pages\/(\d+)\/edit\//);
    return m ? m[1] : null;
  }

  function epCurrentPageId() {
    const id = epPageIdFromPath(location.pathname);
    if (id === null) return null;
    for (const name of EP_PAGE_NAMES) {
      if (EP_PAGE_MAPPING[name] === id) return name;
    }
    return id;
  }

  function epFindEventListBlockIndex() {
    const countEl = document.querySelector('input[name="content_blocks-count"]');
    const count = countEl ? parseInt(countEl.value, 10) || 0 : 0;

    for (let i = 0; i < count; i++) {
      const typeEl = document.querySelector('input[name="content_blocks-' + i + '-type"]');
      if (typeEl && typeEl.value === EP_BLOCK_TYPE) {
        vlog('Synka utvalda event: Block hittat på index ' + i, 'ok');
        return i;
      }
    }
    vlog('Synka utvalda event: Inget block hittat!', 'err');
    return null;
  }

  function epFindEventSubIndices(blockIdx) {
    const prefix = 'content_blocks-' + blockIdx + '-value-events-';
    const re = new RegExp('^' + prefix.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&') + '(\\d+)-value$');
    const found = new Set();
    document.querySelectorAll('input[name^="' + prefix + '"]').forEach(el => {
      const m = re.exec(el.name);
      if (m) found.add(m[1]);
    });
    return [...found];
  }

  function epFindListAddButton(blockIdx) {
    const blockUuidEl = document.querySelector('input[name="content_blocks-' + blockIdx + '-id"]');
    if (!blockUuidEl) return null;

    const blockUuid = blockUuidEl.value;
    let container = document.getElementById('block-' + blockUuid + '-content');
    if (!container) {
      const containers = document.querySelectorAll('[data-contentpath]');
      for (const c of containers) {
        const input = c.querySelector('input[name="content_blocks-' + blockIdx + '-id"]');
        if (input && input.value === blockUuid) {
          container = c;
          break;
        }
      }
    }
    if (!container) return null;

    let addBtn = container.querySelector('button[data-streamfield-list-add], .c-sf-add-button');
    if (addBtn) return addBtn;

    const allAddButtons = document.querySelectorAll('button[data-streamfield-list-add], .c-sf-add-button');
    for (const btn of allAddButtons) {
      const wrapper = btn.closest('[data-contentpath], li, .streamfield-list, .w-streamfield');
      if (wrapper) {
        const eventInputs = wrapper.querySelectorAll('input[name^="content_blocks-' + blockIdx + '-value-events-"]');
        if (eventInputs.length > 0) return btn;
      }
    }
    return null;
  }

  function epFindDeleteButton(rowWrapper) {
    return rowWrapper.querySelector('button[data-streamfield-action="DELETE"]');
  }

  // ===== NY FÖRBÄTTRAD CHOOSER-SÖKFUNKTION =====
  async function epSelectInChooserModal(searchTerm, blockIdx, rowIndex) {
    vlog('Väntar på chooser-modal...');
    const modal = await waitForChooserModal(10000);
    if (!modal) {
      vlog('Chooser-modal hittades inte!', 'err');
      return { ok: false, uncertain: false };
    }

    let searchInput = modal.querySelector('input[type="text"], input[type="search"]');
    if (!searchInput) {
      await wait(500);
      searchInput = modal.querySelector('input[type="text"], input[type="search"]');
    }
    if (!searchInput) {
      vlog('Inget sökfält hittat!', 'err');
      await closeChooserModal();
      return { ok: false, uncertain: false };
    }

    // Rensa söktermen. cleanTerm (hela titeln) används för att POÄNGSÄTTA
    // träffarna, men CMS:ets sökfunktion klarar inte att söka på hela långa
    // titlar (för många ord ger inga träffar) — så det vi faktiskt SKRIVER i
    // sökfältet är bara de första orden, upp till 4 (om titeln har så många).
    //
    // BUGGFIX 2026-09-28: 2 ord räckte inte — bekräftat upprepade gånger att
    // "Yoga at Vrak Museum of Wrecks" med sökfrasen "Yoga at" gav helt
    // orelaterade träffar (bara "Yoga" gemensamt). Troligen stryker CMS:ets
    // sökbackend korta stoppord som "at" helt, så "Yoga at" blir i praktiken
    // samma sökning som bara "Yoga". Med upp till 4 ord kommer sökfrasen
    // nästan alltid innehålla minst ett särskiljande ord till (här: "Vrak"),
    // vilket filtrerar bort de orelaterade träffarna.
    const cleanTerm = cleanDisplayText(searchTerm);
    const queryWords = cleanTerm.split(/\s+/).filter(Boolean);
    let searchQuery = queryWords.slice(0, 4).join(' ');
    // CMS:ets sökfält verkar bara trigga sin AJAX-sökning på en mellanslags-
    // tangenttryckning efter ett avslutat ord, inte på valfri inmatning. En
    // flerordsfras som SLUTAR utan mellanslag (t.ex. "Yoga at") triggar då
    // aldrig en ny sökning — modalen kan stå kvar med gamla/orelaterade
    // träffar, och poängsystemet kan ändå "stabiliseras" kring en av dem och
    // acceptera en helt fel träff (bekräftat 2026-09-25: "Yoga at Vrak..."
    // sökte aldrig fram rätt event, "Outdoor Yoga..." valdes istället).
    // Lägg därför alltid till ett avslutande mellanslag på flerordsfraser,
    // och dispatcha tangenttryckningen FÖR just det mellanslaget.
    if (queryWords.length > 1) searchQuery += ' ';
    vlog('Sökfält hittat, fyller i: "' + searchQuery.trim() + '" (av hela titeln "' + cleanTerm + '")');

    searchInput.focus();
    setNativeInputValue(searchInput, searchQuery);
    searchInput.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: searchQuery.slice(-1) }));
    searchInput.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: searchQuery.slice(-1) }));

    // Vänta längre för att säkerställa att sökresultatet har laddats
    await wait(800);

    // Håller koll på om samma bästa träff dyker upp flera gånger i rad —
    // det betyder att sökresultaten har slutat ändras (klart laddade), så
    // vi ska INTE fortsätta vänta på en "bättre" träff som aldrig kommer.
    let lastBestKey = null;
    let stableCount = 0;

    // Försök upp till 100 gånger (långsammare och mer noggrann)
    for (let attempt = 0; attempt < 100; attempt++) {
      await wait(300); // Längre väntetid mellan försök

      const currentModal = getChooserModal();
      if (!currentModal) {
        vlog('Modal stängd för tidigt', 'warn');
        return { ok: false, uncertain: false };
      }

      // Wagtails FAKTISKA väljar-länkar (bekräftat via DOM-inspektion:
      // <a data-chooser-modal-choice href="/cms/.../chosen/ID/">titel</a>)
      // — dessa ÄR sökträffarna. Den gamla breda skanningen (a, button, li,
      // div, span, tr) plockade upp SAMMA titel flera gånger på olika
      // nivåer (länken själv, dess <div>, <td>, <tr>) som om de vore
      // separata konkurrerande träffar, plus rena sidoelement (rubriker,
      // bläddringsknappar) som råka poängsättas positivt — det var
      // därför "bästa" och "näst bästa" ofta visade EXAKT samma text med
      // olika poäng, och ingendera nådde tröskeln för att klickas.
      const choiceLinks = [...currentModal.querySelectorAll('[data-chooser-modal-choice]')]
        .filter(el => el.offsetParent !== null && el.textContent.trim().length > 0);

      // Fallback till den gamla breda skanningen ENDAST om denna chooser-
      // variant inte skulle använda data-chooser-modal-choice.
      const allHits = choiceLinks.length ? choiceLinks
        : [...currentModal.querySelectorAll('a, button, li, div, span, tr')]
            .filter(el => el !== searchInput && el.offsetParent !== null && el.textContent.trim().length > 0)
            .filter(el => !CHOOSER_IGNORE_TEXTS.has(el.textContent.trim().toLowerCase()));

      if (allHits.length === 0) {
        vlog('Inga träffar hittade än, väntar...', 'work');
        continue;
      }

      // Exakt en riktig väljar-länk: CMS:ets egen sökning har redan filtrerat
      // på det vi skrev in, så lita på den istället för att köra hela
      // poängsystemet mot en ensam kandidat som ändå aldrig får konkurrens.
      if (choiceLinks.length === 1) {
        const only = choiceLinks[0];
        vlog(`Exakt en sökträff: "${cleanDisplayText(only.textContent)}" — accepterar direkt`, 'ok');
        only.click();
        await wait(800);
        if (await verifyFieldFilled(blockIdx, rowIndex)) {
          await closeChooserModal();
          return { ok: true, uncertain: false };
        }
        continue;
      }

      // Beräkna poäng för alla träffar
      const scoredHits = allHits.map(el => {
        const elText = el.textContent;
        const score = calculateMatchScore(elText, cleanTerm, el);
        return { element: el, text: cleanDisplayText(elText), score, originalText: elText };
      }).filter(h => h.score > 0); // Filtrera bort träffar med 0 poäng

      if (scoredHits.length === 0) {
        vlog('Inga matchande träffar hittade', 'warn');
        continue;
      }

      // Sortera efter poäng (högst först)
      scoredHits.sort((a, b) => b.score - a.score);

      const bestHit = scoredHits[0];
      const secondBest = scoredHits[1];

      vlog(`Bästa träff: "${bestHit.text}" (poäng: ${bestHit.score})`);
      if (secondBest) {
        vlog(`Näst bästa: "${secondBest.text}" (poäng: ${secondBest.score})`);
      }

      // STRIKT VALIDERING: Träffen MÅSTE innehålla minst ett av söktermens nyckelord
      const searchKeywords = cleanTerm.toLowerCase().split(/\s+/).filter(k => k.length > 2);
      const hitKeywords = bestHit.text.toLowerCase().split(/\s+/).filter(k => k.length > 2);

      const hasCommonKeyword = searchKeywords.some(kw =>
        hitKeywords.some(hk => hk.includes(kw) || kw.includes(hk))
      );

      if (!hasCommonKeyword && bestHit.score < 800) {
        vlog(`Träffen "${bestHit.text}" matchar inte söktermen tillräckligt bra (poäng: ${bestHit.score}), hoppar över`, 'warn');
        continue;
      }

      // Uppdatera stabilitetsräknaren: samma bästa träff igen = resultaten
      // har slutat ändras.
      const bestKey = bestHit.text + '|' + bestHit.score;
      if (bestKey === lastBestKey) stableCount++;
      else { stableCount = 0; lastBestKey = bestKey; }

      // Om vi har en mycket bra match (poäng > 900), acceptera omedelbart
      if (bestHit.score >= 900) {
        vlog(`Utmärkt match! Accepterar "${bestHit.text}"`, 'ok');
        bestHit.element.click();
        await wait(800);

        if (await verifyFieldFilled(blockIdx, rowIndex)) {
          await closeChooserModal();
          return { ok: true, uncertain: false };
        }
        continue;
      }

      // Om vi har en bra match (poäng > 700) och ingen andra bra matches, acceptera
      if (bestHit.score > 700 && (!secondBest || secondBest.score < bestHit.score - 100)) {
        vlog(`Bra match! Accepterar "${bestHit.text}"`, 'ok');
        bestHit.element.click();
        await wait(800);

        if (await verifyFieldFilled(blockIdx, rowIndex)) {
          await closeChooserModal();
          return { ok: true, uncertain: false };
        }
        continue;
      }

      // BUGGFIX: tidigare hamnade koden här i en oändlig väntan om bästa
      // träffen aldrig blev "tillräckligt bra" ensam (t.ex. en nästan lika
      // bra tvåa inom 100 poäng) — sökresultaten från CMS:et ändras inte mer
      // efter att de laddats klart, så "vänta på bättre resultat" väntade på
      // något som aldrig skulle hända, och rätt träff klickades ALDRIG trots
      // att den syntes i listan. Om samma bästa träff är oförändrad två
      // kontroller i rad (resultaten har stabiliserats) och den ändå är en
      // rimlig match, acceptera den istället för att fortsätta vänta.
      //
      // BUGGFIX v4.1: kravet på ett absolut poängtak (> 600) var kalibrerat
      // för den gamla, brusiga kandidatpoolen (dubbletter/paginering etc).
      // Nu när allHits bara innehåller riktiga data-chooser-modal-choice-
      // träffar har CMS:ets egen sökning redan gjort relevansfiltreringen —
      // en låg poäng (t.ex. 195) kan ändå vara den korrekta träffen om den
      // klart leder över tvåan. Lita därför på den relativa rangordningen
      // när resultaten stabiliserats, istället för ett absolut poängkrav.
      if (stableCount >= 2 && (!secondBest || bestHit.score > secondBest.score)) {
        // Denna gren accepterar per definition en träff som ALDRIG blev
        // "Utmärkt" (≥900) eller "Bra" (>700 med tydlig marginal) ovan —
        // dvs. den svagast underbyggda accepteringen. Flaggas därför alltid
        // som osäker uppåt i kedjan, så KLART!-sammanfattningen kan lista
        // vilka rader som bör dubbelkollas manuellt.
        vlog(`OSÄKER TRÄFF (poäng ${bestHit.score}, ej "utmärkt"/"bra") — accepterar ändå eftersom resultaten stabiliserats: "${bestHit.text}". Dubbelkolla manuellt!`, 'warn');
        bestHit.element.click();
        await wait(800);

        if (await verifyFieldFilled(blockIdx, rowIndex)) {
          await closeChooserModal();
          return { ok: true, uncertain: true };
        }
        continue;
      }

      // Om vi har flera bra matches och resultaten inte stabiliserats än, vänta och försök igen
      if (secondBest && secondBest.score > 600) {
        vlog(`Flera bra matches hittade, väntar på bättre result...`, 'work');
        continue;
      }
    }

    vlog('Ingen tillräckligt bra träff för "' + cleanTerm + '"', 'err');

    // FALLBACK: Försök med kortare sökterm
    if (cleanTerm.length > 20) {
      const shorterTerm = cleanTerm.substring(0, Math.floor(cleanTerm.length * 0.7));
      vlog(`Försöker med kortare sökterm: "${shorterTerm}"`, 'work');
      return epSelectInChooserModal(shorterTerm, blockIdx, rowIndex);
    }

    await closeChooserModal();
    return { ok: false, uncertain: false };
  }

  async function verifyFieldFilled(blockIdx, rowIndex) {
    if (blockIdx === undefined || rowIndex === undefined) {
      return true;
    }

    const pfx = 'content_blocks-' + blockIdx + '-value-';
    const valueField = $(pfx + 'events-' + rowIndex + '-value');

    if (!valueField) return true;

    for (let j = 0; j < 30; j++) {
      await wait(200);
      if (valueField.value) {
        vlog('Fältet fylls i! value=' + valueField.value, 'ok');
        return true;
      }
    }

    vlog('Fältet fylldes INTE i, försöker manuell uppdatering...', 'warn');
    const modal = getChooserModal();
    if (modal) {
      const selected = modal.querySelector('[data-chooser-action-choose][data-id], a[data-id], button[data-id]');
      if (selected) {
        const eventId = selected.getAttribute('data-id') ||
                       selected.closest('[data-id]')?.getAttribute('data-id') ||
                       selected.getAttribute('data-value') ||
                       selected.closest('[data-value]')?.getAttribute('data-value');
        if (eventId) {
          vlog('Manuell uppdatering med ID: ' + eventId);
          valueField.value = eventId;
          valueField.dispatchEvent(new Event('change', { bubbles: true }));
          await wait(500);
          return true;
        }
      }
    }
    return false;
  }

  async function epOpenChooserForRow(rowWrapper) {
    const btn = rowWrapper.querySelector('button[data-chooser-action-choose]');
    if (!btn) {
      vlog('Ingen chooser-knapp hittad', 'err');
      return false;
    }
    vlog('Klickar på chooser-knapp');
    btn.click();
    await waitForChooserModal(10000);
    return true;
  }

  // ===== CLEAR AND FILL =====
  async function epClearAndFill() {
    if (isFilling) {
      vlog('En ifyllning pågår redan, vänta...', 'warn');
      return;
    }
    isFilling = true;
    successfulFills = 0;
    const uncertainRows = []; // rader ifyllda via den svagast underbyggda matchningen — bör dubbelkollas manuellt

    try {
      const blockIdx = epFindEventListBlockIndex();
      if (blockIdx === null) {
        vlog('Inget Event list-block hittat!', 'err');
        setEpStatus('❌ Fel: Inget block hittat');
        return;
      }

      let stored;
      try { stored = JSON.parse(GM_getValue(EP_STORAGE_KEY, '{}')); } catch {
        vlog('Ogiltig kopierad data!', 'err');
        setEpStatus('❌ Fel: Ogiltig data');
        return;
      }
      if (!stored.events || !Array.isArray(stored.events)) {
        vlog('Inga event i kopierad data!', 'err');
        setEpStatus('❌ Fel: Inga event att fylla i');
        return;
      }

      // Rensa displayText för alla event
      stored.events = stored.events.map(ev => ({
        ...ev,
        displayText: cleanDisplayText(ev.displayText)
      }));

      const validEvents = stored.events.filter(ev => ev.displayText?.trim());
      if (validEvents.length === 0) {
        vlog('ALLA event saknar namn!', 'err');
        setEpStatus('❌ Fel: Inga giltiga event');
        return;
      }

      vlog('Kommer att fylla i ' + validEvents.length + ' event', 'ok');

      const pfx = 'content_blocks-' + blockIdx + '-value-';

      // OBS: Titel, preamble och link text ska ALDRIG uppdateras av scriptet
      // (togs bort — en tidigare version skrev över dem, vilket var fel).
      const sortEl = $(pfx + 'sort_by_date');
      if (sortEl) {
        sortEl.checked = !!stored.sortByDate;
        sortEl.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (stored.excludeUrls) {
        const excludeMirror = epMirrorExcludeUrls(stored.excludeUrls);
        simulateInput($(pfx + 'excludetree'), excludeMirror.text);
        if (excludeMirror.added.length > 0) {
          vlog('La till ' + excludeMirror.added.length + ' spegel-url(er) i Exclude urls (båda språkdomänerna)', 'ok');
        }
        GM_setClipboard(excludeMirror.text);
      }

      // STEG 1: Radera befintliga
      vlog('Raderar befintliga event...');
      const initialSubIdxs = epFindEventSubIndices(blockIdx);
      vlog('Hittade ' + initialSubIdxs.length + ' rader att radera');

      for (const si of initialSubIdxs) {
        const valEl = $(pfx + 'events-' + si + '-value');
        if (!valEl || !valEl.value) continue;
        const wrapper = valEl.closest('li, [data-contentpath]') || valEl.parentElement;
        if (!wrapper) continue;
        const delBtn = epFindDeleteButton(wrapper);
        if (delBtn) {
          vlog('Raderar rad ' + si);
          delBtn.click();
          await wait(800);
        } else {
          vlog('Ingen raderingsknapp för rad ' + si, 'err');
        }
      }
      await wait(1500);

      // STEG 2: Lägg till nya rader
      const addBtn = epFindListAddButton(blockIdx);
      if (!addBtn) {
        vlog('Kunde inte hitta plusknapp för events-listan!', 'err');
        setEpStatus('❌ Fel: Ingen plusknapp hittad');
        return;
      }

      let subIdxs = epFindEventSubIndices(blockIdx);
      let emptyCount = subIdxs.filter(si => !$(pfx + 'events-' + si + '-value')?.value).length;

      vlog('Har ' + emptyCount + ' tomma rader, behöver ' + validEvents.length);

      while (emptyCount < validEvents.length) {
        vlog('Lägger till rad...');
        addBtn.click();
        await wait(800);
        subIdxs = epFindEventSubIndices(blockIdx);
        emptyCount = subIdxs.filter(si => !$(pfx + 'events-' + si + '-value')?.value).length;
        vlog('Har nu ' + emptyCount + ' tomma rader');
      }

      // STEG 3: Fyll i event
      subIdxs = epFindEventSubIndices(blockIdx);
      const emptyRows = subIdxs.map(si => $(pfx + 'events-' + si + '-value'))
          .filter(el => el && !el.value)
          .map((el, index) => ({ element: el, wrapper: el.closest('li, [data-contentpath]') || el.parentElement, index: subIdxs[index] }))
          .filter(Boolean)
          .slice(0, validEvents.length);

      vlog('Kommer att fylla ' + Math.min(emptyRows.length, validEvents.length) + ' rader');

      for (let i = 0; i < Math.min(emptyRows.length, validEvents.length); i++) {
        const ev = validEvents[i];
        const row = emptyRows[i];
        if (!ev.displayText) continue;

        vlog('Fyller rad ' + (i+1) + ' med "' + ev.displayText + '"');

        const opened = await epOpenChooserForRow(row.wrapper);
        if (!opened) {
          vlog('Kunde inte öppna chooser för rad ' + (i+1), 'err');
          continue;
        }

        const result = await epSelectInChooserModal(ev.displayText, blockIdx, row.index);
        if (result.ok) {
          successfulFills++;
          if (result.uncertain) {
            uncertainRows.push(i + 1);
            vlog('Rad ' + (i+1) + ' ifylld MEN med en osäker träff — dubbelkolla manuellt!', 'warn');
          } else {
            vlog('Rad ' + (i+1) + ' ifylld', 'ok');
          }
        } else {
          vlog('Kunde inte fylla rad ' + (i+1), 'err');
        }
        await wait(1000); // Längre väntetid mellan varje event
      }

      // UPPPDATERAT STATUSMEDDELANDE
      const uncertainNote = uncertainRows.length
        ? (' ⚠️ Osäkra rader (dubbelkolla): ' + uncertainRows.join(', '))
        : '';
      if (successfulFills === validEvents.length) {
        vlog('KLART! Alla ' + successfulFills + ' event ifyllda' + (uncertainRows.length ? '. OSÄKRA rader: ' + uncertainRows.join(', ') : ''), uncertainRows.length ? 'warn' : 'ok');
        setEpStatus((uncertainRows.length ? '⚠️ ' : '✅ ') + successfulFills + '/' + validEvents.length + ' event ifyllda' + uncertainNote);
      } else if (successfulFills > 0) {
        vlog('Delvis framgång: ' + successfulFills + '/' + validEvents.length + ' event ifyllda' + (uncertainRows.length ? '. OSÄKRA rader: ' + uncertainRows.join(', ') : ''), 'warn');
        setEpStatus('⚠️ ' + successfulFills + '/' + validEvents.length + ' event ifyllda' + uncertainNote);
      } else {
        vlog('MISSLYCKADES: Inga event ifyllda', 'err');
        setEpStatus('❌ 0/' + validEvents.length + ' event ifyllda');
      }

    } catch (error) {
      vlog('Fel: ' + error.message, 'err');
      setEpStatus('❌ Fel: ' + error.message);
    } finally {
      isFilling = false;
    }
  }

  function setEpStatus(msg) {
    const s = document.getElementById('ep-status');
    if (s) s.textContent = msg;
  }

  async function epCopyFields() {
    if (isFilling) {
      vlog('Vänta på att ifyllning slutförs...', 'warn');
      return;
    }

    const blockIdx = epFindEventListBlockIndex();
    if (blockIdx === null) return;

    const pfx = 'content_blocks-' + blockIdx + '-value-';
    // OBS: Titel, preamble och link text kopieras/uppdateras ALDRIG (togs bort).
    const sortByDate = !!($(pfx + 'sort_by_date') || {}).checked;
    let excludeUrls = ($(pfx + 'excludetree') || {}).value || '';

    const excludeMirror = epMirrorExcludeUrls(excludeUrls);
    if (excludeMirror.added.length > 0) {
      simulateInput($(pfx + 'excludetree'), excludeMirror.text);
      excludeUrls = excludeMirror.text;
      vlog('La till ' + excludeMirror.added.length + ' spegel-url(er) i Exclude urls (båda språkdomänerna)', 'ok');
    }

    const subIdxs = epFindEventSubIndices(blockIdx);
    vlog('Hittade ' + subIdxs.length + ' rad-index i blocket: ' + subIdxs.join(', '));
    const events = [];

    for (const si of subIdxs) {
      const valEl = $(pfx + 'events-' + si + '-value');
      if (!valEl || !valEl.value) {
        vlog('  Rad ' + si + ': inget värde, hoppar över.');
        continue;
      }

      const wrapper = valEl.closest('li, [data-contentpath]') || valEl.parentElement;

      // Wagtails StreamField-radering är "mjuk": klick på papperskorgen
      // döljer raden direkt i DOM:en (för att kunna ångra), men tar INTE
      // bort de underliggande fält-inputs förrän sidan faktiskt sparas.
      // En rad som användaren precis raderat manuellt utan att spara sidan
      // finns alltså kvar med sitt gamla värde om man bara letar efter
      // inputs — måste explicit hoppa över dolda/raderade rader.
      const style = wrapper ? getComputedStyle(wrapper) : null;
      const isHidden = !wrapper || wrapper.offsetParent === null ||
        style.visibility === 'hidden' || style.display === 'none' ||
        wrapper.hasAttribute('hidden') || wrapper.getAttribute('aria-hidden') === 'true';
      if (isHidden) {
        vlog('  Rad ' + si + ' (id=' + valEl.value + '): dold i DOM:en — troligen raderad manuellt utan att sidan sparats. Hoppar över.' +
          (wrapper ? ' [class="' + wrapper.className + '"]' : ' [ingen wrapper hittad]'), 'warn');
        continue;
      }

      const orderEl = document.querySelector('input[name="' + pfx + 'events-' + si + '-order"]');

      let displayText = '';
      if (wrapper) {
        const directChildren = wrapper.querySelectorAll('a, strong, span, div, label, .title');
        for (const el of directChildren) {
          const text = el.textContent.trim();
          if (text && text.length > 1 && text.length < 200) {
            displayText = text;
            break;
          }
        }

        if (!displayText) {
          const walker = document.createTreeWalker(wrapper, NodeFilter.SHOW_TEXT);
          let node;
          while (node = walker.nextNode()) {
            const text = node.textContent.trim();
            if (text && text.length > 1 && text.length < 200) {
              displayText = text;
              break;
            }
          }
        }

        if (!displayText && valEl.value) {
          displayText = valEl.value.split('/').pop();
        }
      }

      displayText = cleanDisplayText(displayText);

      vlog('  Rad ' + si + ': id=' + valEl.value + ', order=' + (orderEl ? orderEl.value : '?') + ', text="' + displayText + '" — inkluderas.', 'ok');

      events.push({
        id: valEl.value,
        order: orderEl ? parseInt(orderEl.value, 10) : 0,
        displayText: displayText || 'Event ' + (events.length + 1)
      });
    }

    events.sort((a, b) => a.order - b.order);
    vlog('Kopierade ' + events.length + ' event: ' + events.map(e => '"' + e.displayText + '"').join(', '), 'ok');

    GM_setValue(EP_STORAGE_KEY, JSON.stringify({
      sortByDate, excludeUrls, events, ts: Date.now()
    }));

    if (excludeUrls) GM_setClipboard(excludeUrls);

    setEpStatus('✅ Kopierat ' + events.length + ' event, samt excluderade url:er');
  }

  function epClearStoredData() {
    GM_setValue(EP_STORAGE_KEY, '');
    setEpStatus('Data rensad');
  }

  function epOpenOtherPages() {
    const currentPage = epCurrentPageId();
    const others = EP_PAGE_NAMES.filter(name => name !== currentPage);

    const existing = document.getElementById('ep-open-links');
    if (existing) existing.remove();

    const wrap = document.createElement('span');
    wrap.id = 'ep-open-links';
    wrap.style.marginLeft = '8px';
    wrap.innerHTML = others.map(name => {
      const pageId = EP_PAGE_MAPPING[name];
      return `<a href="${location.origin}/cms/pages/${pageId}/edit/" target="_blank" rel="noopener" style="color:var(--vd-accent); margin-right:6px; font-size:11px; text-decoration:none;">${name}</a>`;
    }).join('');
    document.getElementById('ep-fill').insertAdjacentElement('afterend', wrap);
  }

  // ===== UI MED FIXAD POSITIONERING =====
  const EP_CSS = `
    :root {
      --vd-bg:#1e222b;
      --vd-bg2:#262b36;
      --vd-bg3:#2f3542;
      --vd-line:#3a3f4b;
      --vd-txt:#e8eaee;
      --vd-txt2:#a8adb8;
      --vd-txt3:#787e8a;
      --vd-accent:#4a9fe0;
    }
    #ep-bar {
      position: fixed !important;
      top: 0 !important;
      left: 0 !important;
      right: 0 !important;
      z-index: 999999 !important;
      background: var(--vd-bg);
      border-bottom: 2px solid var(--vd-accent);
      box-shadow: 0 4px 20px rgba(0,0,0,.4);
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      font-family: system-ui, sans-serif;
      color: var(--vd-txt);
      font-size: 13px;
    }
    #ep-bar .ep-title {
      font-weight: 700;
      white-space: nowrap;
    }
    #ep-bar .ep-g {
      flex: 1;
    }
    #ep-bar button {
      background: var(--vd-bg2);
      border: 1px solid var(--vd-line);
      color: var(--vd-txt);
      border-radius: 5px;
      padding: 6px 10px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
    }
    #ep-bar button:hover {
      background: var(--vd-bg3);
    }
    #ep-bar button.ep-primary {
      background: var(--vd-accent);
      color: #0d1520;
      border: none;
    }
    #ep-bar button.ep-primary:hover {
      filter: brightness(1.1);
    }
    #ep-bar button.ep-danger {
      color: #ff8080;
    }
    #ep-bar button.ep-log {
      background: var(--vd-bg3);
    }
    #ep-status {
      font-size: 11px;
      color: var(--vd-txt3);
      margin-left: 8px;
      white-space: nowrap;
    }
    #ep-logwrap {
      display: none;
      position: fixed !important;
      top: 40px !important;
      left: 10px !important;
      z-index: 999998 !important;
      width: 500px;
      max-height: 70vh;
      background: var(--vd-bg2);
      border: 1px solid var(--vd-line);
      border-radius: 8px;
      box-shadow: 0 4px 20px rgba(0,0,0,.6);
      overflow: hidden;
      resize: both;
    }
    #ep-loghdr {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 6px 8px;
      background: var(--vd-bg3);
      border-bottom: 1px solid var(--vd-line);
      font-size: 11px;
      font-weight: 600;
    }
    #ep-log {
      overflow-y: auto;
      height: calc(100% - 30px);
      padding: 8px;
      font-family: monospace;
      font-size: 11px;
      line-height: 1.5;
      white-space: pre-wrap;
    }
    .sb-logline {
      white-space: pre-wrap;
      word-break: break-word;
    }
    .sb-logline.err {
      color: #ff8080;
    }
    .sb-logline.ok {
      color: #7ddca0;
    }
    .sb-logline.work {
      color: #e0b060;
    }
    #ep-loghdr button {
      background: rgba(255,255,255,.08);
      border: none;
      color: var(--vd-txt);
      height: 20px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 10px;
      padding: 0 5px;
      margin-left: 4px;
    }
    #ep-bar-mini {
      position: fixed;
      top: 10px;
      right: 10px;
      z-index: 999999;
      width: 36px;
      height: 36px;
      background: var(--vd-bg);
      border: 2px solid var(--vd-accent);
      border-radius: 8px;
      box-shadow: 0 4px 20px rgba(0,0,0,.4);
      display: none;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      font-size: 15px;
    }
    #ep-bar-mini:hover {
      background: var(--vd-bg2);
    }
    #ep-open-links {
      margin-left: 8px;
    }
    #ep-open-links a {
      color: var(--vd-accent);
      margin-right: 6px;
      font-size: 11px;
      text-decoration: none;
    }
    #ep-open-links a:hover {
      text-decoration: underline;
    }
  `;

  function buildEventportorBar() {
    const baseStyle = document.createElement('style');
    baseStyle.textContent = `:root {
      --vd-bg: #1e222b;
      --vd-bg2: #262b36;
      --vd-bg3: #2f3542;
      --vd-line: #3a3f4b;
      --vd-txt: #e8eaee;
      --vd-txt2: #a8adb8;
      --vd-txt3: #787e8a;
      --vd-accent: #4a9fe0;
    }`;
    document.head.appendChild(baseStyle);

    const style = document.createElement('style');
    style.textContent = EP_CSS;
    document.head.appendChild(style);

    const bar = document.createElement('div');
    bar.id = 'ep-bar';
    bar.innerHTML = `
      <span class="ep-title">Synka utvalda event</span>${versionBadgeHTML()}
      <button type="button" id="ep-copy">📋 Kopiera</button>
      <button type="button" id="ep-fill" class="ep-primary">🧹 Rensa & fyll</button>
      <button type="button" id="ep-clear-data" class="ep-danger" title="Rensa data">🗑️</button>
      <button type="button" id="ep-logbtn" class="ep-log" title="Visa logg">📋 Logg</button>
      <span id="ep-status"></span>
      <span class="ep-g"></span>
      <button type="button" id="ep-min" title="Minimera">▁</button>
    `;
    document.body.appendChild(bar);
    document.body.style.paddingTop = (bar.offsetHeight || 40) + 'px';
    document.body.style.marginTop = '0 !important';

    const logWrap = document.createElement('div');
    logWrap.id = 'ep-logwrap';
    logWrap.innerHTML = `
      <div id="ep-loghdr">
        <span>Logg</span>
        <span>
          <button type="button" id="ep-logcopy" title="Kopiera">📋</button>
          <button type="button" id="ep-logclear" title="Rensa">🗑️</button>
          <button type="button" id="ep-logclose">✕</button>
        </span>
      </div>
      <div id="ep-log"></div>
    `;
    document.body.appendChild(logWrap);

    const mini = document.createElement('div');
    mini.id = 'ep-bar-mini';
    mini.title = 'Visa Synka utvalda event';
    mini.textContent = '📋';
    document.body.appendChild(mini);

    // Logg-knappar
    document.getElementById('ep-logbtn').addEventListener('click', () => {
      const w = document.getElementById('ep-logwrap');
      w.style.display = w.style.display === 'none' ? 'block' : 'none';
      if (w.style.display === 'block') renderLog();
    });
    document.getElementById('ep-logclose').addEventListener('click', () => {
      document.getElementById('ep-logwrap').style.display = 'none';
    });
    document.getElementById('ep-logcopy').addEventListener('click', async () => {
      const btn = document.getElementById('ep-logcopy');
      const text = VLOG.map(e => e.line).join('\n');
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = '✓'; setTimeout(() => btn.textContent = '📋', 1500);
      } catch { btn.textContent = '✗'; setTimeout(() => btn.textContent = '📋', 1500); }
    });
    document.getElementById('ep-logclear').addEventListener('click', () => { VLOG = []; renderLog(); });

    // Minimera
    function minimize() {
      bar.style.display = 'none';
      document.body.style.paddingTop = '';
      document.body.style.marginTop = '';
      mini.style.display = 'flex';
      document.getElementById('ep-logwrap').style.display = 'none';
    }
    function restore() {
      bar.style.display = 'flex';
      document.body.style.paddingTop = (bar.offsetHeight || 40) + 'px';
      document.body.style.marginTop = '0 !important';
      mini.style.display = 'none';
    }
    document.getElementById('ep-min').addEventListener('click', minimize);
    mini.addEventListener('click', restore);

    // Knappar
    document.getElementById('ep-copy').addEventListener('click', epCopyFields);
    document.getElementById('ep-fill').addEventListener('click', epClearAndFill);
    document.getElementById('ep-clear-data').addEventListener('click', epClearStoredData);

    // Länkar för andra sidor
    epOpenOtherPages();

    vlog('Synka utvalda event v' + SCRIPT_VERSION + ' startad', 'ok');
  }

  // ===== HUVUDPANEL =====
  const PANEL_CSS = `
    :root {
      --vd-bg: #1e222b;
      --vd-bg2: #262b36;
      --vd-bg3: #2f3542;
      --vd-line: #3a3f4b;
      --vd-txt: #e8eaee;
      --vd-txt2: #a8adb8;
      --vd-txt3: #787e8a;
      --vd-accent: #4a9fe0;
    }
    #sb-panel {
      position: fixed;
      z-index: 999999;
      background: var(--vd-bg);
      color: var(--vd-txt);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      border: 1px solid var(--vd-line);
      border-radius: 12px;
      box-shadow: 0 10px 40px rgba(0,0,0,.5);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      bottom: 18px;
      right: 18px;
      width: 300px;
      max-height: calc(100vh - 36px);
    }
    #sb-panel.max {
      top: 18px;
      bottom: 18px;
      right: 18px;
      width: 420px;
    }
    #sb-panel.min #sb-scroll,
    #sb-panel.min #sb-tabbar {
      display: none;
    }
    #sb-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 11px 13px;
      background: var(--vd-bg2);
      border-bottom: 1px solid var(--vd-line);
      flex-shrink: 0;
    }
    #sb-head .t {
      font-size: 17px;
      font-weight: 700;
      letter-spacing: -.01em;
    }
    #sb-headbtns {
      display: flex;
      gap: 3px;
      align-items: center;
    }
    #sb-headbtns .g {
      width: 14px;
      display: inline-block;
    }
    #sb-headbtns button {
      background: rgba(255,255,255,.08);
      border: none;
      color: var(--vd-txt);
      cursor: pointer;
      width: 26px;
      height: 24px;
      border-radius: 6px;
      font-size: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    #sb-headbtns button:hover {
      background: rgba(255,255,255,.18);
    }
    #sb-headbtns button.on {
      background: var(--vd-accent);
      color: #0d1520;
    }
    #sb-tabbar {
      display: flex;
      gap: 3px;
      padding: 8px 10px 0;
      background: var(--vd-bg2);
      border-bottom: 1px solid var(--vd-line);
      flex-shrink: 0;
    }
    .sb-tab-btn {
      background: transparent;
      border: none;
      color: var(--vd-txt2);
      font-size: 12.5px;
      font-weight: 650;
      padding: 7px 12px;
      border-radius: 6px 6px 0 0;
      cursor: pointer;
    }
    .sb-tab-btn:hover {
      color: var(--vd-txt);
      background: rgba(255,255,255,.06);
    }
    .sb-tab-btn.active {
      color: var(--vd-accent);
      background: var(--vd-bg);
      box-shadow: inset 0 -2px 0 var(--vd-accent);
    }
    .sb-tab-panel {
      display: none;
    }
    .sb-tab-panel.active {
      display: block;
    }
    #sb-scroll {
      overflow-y: auto;
      padding: 14px 15px;
      flex: 1;
    }
    .sb-row {
      margin-bottom: 11px;
    }
    .sb-setfieldbtns {
      display: flex;
      gap: 8px;
      margin-top: 4px;
    }
    .sb-setfieldbtns button {
      flex: 1;
      background: var(--vd-bg2);
      border: 1px solid var(--vd-line);
      color: var(--vd-txt);
      cursor: pointer;
      padding: 7px 8px;
      border-radius: 7px;
      font-size: 12px;
      font-family: inherit;
    }
    .sb-setfieldbtns button:hover {
      border-color: var(--vd-accent);
    }
    .sb-dropzone {
      margin-top: 4px;
      margin-bottom: 11px;
      border: 1px dashed var(--vd-line);
      border-radius: 7px;
      padding: 14px 10px;
      text-align: center;
      font-size: 12px;
      color: var(--vd-txt2);
      cursor: pointer;
      transition: border-color .15s, background .15s;
    }
    .sb-dropzone.hover {
      border-color: var(--vd-accent);
      background: var(--vd-bg2);
    }
    .sb-dropzone input[type="file"] {
      display: none;
    }
    .sb-row label {
      display: block;
      font-size: 11px;
      font-weight: 600;
      color: var(--vd-txt2);
      text-transform: uppercase;
      letter-spacing: .04em;
      margin-bottom: 5px;
    }
    .sb-key {
      width: 100%;
      box-sizing: border-box;
      /* !important: sidan (Wagtail-admin) har egna input-regler som annars
         kan vinna över dessa och göra fältet oläsligt i ljust läge. */
      background: var(--vd-bg2) !important;
      border: 1px solid var(--vd-line);
      color: var(--vd-txt) !important;
      border-radius: 7px;
      padding: 8px 10px;
      font-size: 12.5px;
      font-family: inherit;
      /* Alltid "light": vi sätter redan bakgrund/text själva för båda
         teman, så detta bara hindrar webbläsarens EGEN mörkt-läge-styling
         (t.ex. OS i mörkt läge) från att krocka med våra egna färger. */
      color-scheme: light;
    }
    .sb-key:focus {
      outline: none;
      border-color: var(--vd-accent);
    }
    .sb-check {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12.5px;
      font-weight: 600;
      color: var(--vd-txt);
      cursor: pointer;
      margin-bottom: 11px;
    }
    .sb-check input {
      width: 16px;
      height: 16px;
      accent-color: var(--vd-accent);
      cursor: pointer;
      margin: 0;
      flex-shrink: 0;
      flex: none;
      display: grid;
      place-content: center;
      appearance: none;
      -webkit-appearance: none;
      border: 1.5px solid var(--vd-line);
      border-radius: 4px;
      background: var(--vd-bg2);
    }
    .sb-check input::before {
      content: '';
      width: 10px;
      height: 10px;
      transform: scale(0);
      transition: transform .08s;
      clip-path: polygon(14% 44%, 0 65%, 50% 100%, 100% 16%, 80% 0%, 43% 62%);
      background: var(--vd-accent);
    }
    .sb-check input:checked::before {
      transform: scale(1);
    }
    .sb-check input:checked {
      border-color: var(--vd-accent);
    }
    .sb-toggle-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      font-size: 12.5px;
      font-weight: 600;
      color: var(--vd-txt);
      margin-bottom: 16px;
    }
    .sb-toggle {
      position: relative;
      display: inline-flex;
      align-items: center;
      width: 38px;
      height: 22px;
      flex-shrink: 0;
      cursor: pointer;
    }
    .sb-toggle input {
      position: absolute;
      inset: 0;
      opacity: 0;
      margin: 0;
      cursor: pointer;
    }
    .sb-toggle-track {
      position: absolute;
      inset: 0;
      background: var(--vd-line);
      border-radius: 999px;
      transition: background .15s;
    }
    .sb-toggle-track::before {
      content: '';
      position: absolute;
      top: 3px;
      left: 3px;
      width: 16px;
      height: 16px;
      background: #fff;
      border-radius: 50%;
      box-shadow: 0 1px 3px rgba(0,0,0,.35);
      transition: transform .15s;
    }
    .sb-toggle input:checked ~ .sb-toggle-track {
      background: var(--vd-accent);
    }
    .sb-toggle input:checked ~ .sb-toggle-track::before {
      transform: translateX(16px);
    }
    .sb-langrow {
      display: flex;
      gap: 8px;
      margin-bottom: 12px;
    }
    .sb-langrow button {
      flex: 1;
      background: var(--vd-accent);
      color: #0d1520;
      border: none;
      border-radius: 7px;
      padding: 11px 6px;
      font-size: 13px;
      font-weight: 650;
      cursor: pointer;
    }
    .sb-langrow button:hover:not(:disabled) {
      filter: brightness(1.1);
    }
    .sb-langrow button:disabled {
      background: var(--vd-line);
      color: var(--vd-txt3);
      cursor: not-allowed;
    }
    .sb-status {
      font-size: 11px;
      font-weight: 600;
      margin-bottom: 12px;
      padding: 8px 10px;
      border-radius: 7px;
      font-family: monospace;
      display: none;
      line-height: 1.5;
    }
    .sb-status.work {
      color: #e0b060;
      background: #2a2620;
      border: 1px solid #4a4230;
    }
    .sb-status.ok {
      color: #7ddca0;
      background: #1f2f26;
      border: 1px solid #2f5a42;
    }
    .sb-status.err {
      color: #ff8080;
      background: #3a1f1f;
      border: 1px solid #6a2a2a;
    }
    .sb-whatson-section-title {
      font-size: 11px;
      font-weight: 700;
      color: var(--vd-txt2);
      text-transform: uppercase;
      letter-spacing: .04em;
      margin: 14px 0 6px;
      cursor: pointer;
      user-select: none;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .sb-whatson-collapsible .sb-whatson-arrow {
      display: inline-block;
      transition: transform .15s ease;
      font-size: 10px;
      color: var(--vd-txt3);
    }
    .sb-whatson-collapsible.sb-collapsed .sb-whatson-arrow {
      transform: rotate(-90deg);
    }
    .sb-whatson-collapsible.sb-collapsed .sb-whatson-list {
      display: none;
    }
    .sb-whatson-list {
      max-height: 220px;
      overflow-y: auto;
      border: 1px solid var(--vd-line);
      border-radius: 7px;
      padding: 6px 8px;
    }
    .sb-whatson-item {
      margin-bottom: 6px;
      align-items: flex-start;
    }
    .sb-whatson-item span {
      line-height: 1.4;
    }
    .sb-whatson-lang {
      display: flex;
      gap: 14px;
      margin: 6px 0 2px;
    }
    .sb-whatson-guidegrid {
      display: flex;
      gap: 12px;
      align-items: flex-start;
    }
    .sb-whatson-guidecol {
      flex: 1;
      min-width: 0;
    }
    .sb-whatson-coltitle {
      font-size: 11px;
      font-weight: 700;
      margin-bottom: 4px;
    }
    .sb-whatson-date {
      color: var(--vd-txt3);
      font-weight: 500;
    }
    #sb-logwrap {
      display: none;
      flex-direction: column;
      border-top: 1px solid var(--vd-line);
      max-height: 260px;
      background: var(--vd-bg2);
      flex-shrink: 0;
    }
    #sb-log {
      overflow-y: auto;
      flex: 1;
      min-height: 0;
      padding: 6px 11px 10px;
      font-size: 11px;
      line-height: 1.5;
    }
    .sb-loghdr {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 7px 11px;
      font-size: 10.5px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: .04em;
      color: var(--vd-txt2);
    }
    .sb-loghdr span {
      display: flex;
      gap: 5px;
    }
    .sb-loghdr button {
      background: rgba(255,255,255,.08);
      border: none;
      color: var(--vd-txt);
      height: 20px;
      border-radius: 5px;
      cursor: pointer;
      font-size: 11px;
      padding: 0 6px;
    }
  `;

  function injectStyle() {
    if (!document.getElementById('sb-style')) {
      const s = document.createElement('style');
      s.id = 'sb-style';
      s.textContent = PANEL_CSS;
      document.head.appendChild(s);
    }
  }

  // Inställningsvärdena backas också upp till localStorage och hydreras
// tillbaka om GM-lagringen är tom (t.ex. efter en script-uppdatering),
// så fälten aldrig står tomma. Toppnivå så de kan köras var som helst —
// även på EventPortal-sidor där buildPanel() aldrig körs.
const SETTINGS_KEYS = ['sidbot_mkey', 'sidbot_magent', 'sidbot_magent_whatson', 'sidbot_calendar_api'];
const LS_KEY = 'editorbot_settings_backup_v1';
function backupSettingsToLS() {
  try {
    const data = {};
    SETTINGS_KEYS.forEach(k => { data[k] = GM_getValue(k, ''); });
    localStorage.setItem(LS_KEY, JSON.stringify(data));
  } catch {}
}
function restoreSettingsFromLS() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return false;
    const obj = JSON.parse(raw);
    let restored = 0;
    SETTINGS_KEYS.forEach(k => {
      if (!GM_getValue(k, '').trim() && typeof obj[k] === 'string' && obj[k].trim()) {
        GM_setValue(k, obj[k].trim());
        restored++;
      }
    });
    return restored > 0;
  } catch { return false; }
}
function buildPanel() {
    injectStyle();
    const p = document.createElement('div');
    p.id = 'sb-panel';
    document.body.appendChild(p);
    p.innerHTML = `
      <div id="sb-head">
        <div class="t">EditorBot${versionBadgeHTML()}</div>
        <div id="sb-headbtns">
          <button type="button" data-m="min" title="Minimera">▁</button>
          <button type="button" data-m="max" title="Maximera">▢</button>
          <span class="g"></span>
          <button type="button" id="sb-mapbtn" title="Kartlägg fält">🔍</button>
          <button type="button" id="sb-logbtn" title="Visa logg">📋</button>
        </div>
      </div>
      <div id="sb-tabbar">
        <button type="button" class="sb-tab-btn active" data-tab="main">EditorBot</button>
        <button type="button" class="sb-tab-btn" data-tab="whatson">WHAT'S ON</button>
        <button type="button" class="sb-tab-btn" data-tab="settings" title="Inställningar">⚙️</button>
      </div>
      <div id="sb-scroll">
        <div class="sb-tab-panel active" data-tab-panel="main">
          <div class="sb-row"><label>Sida-URL</label><input type="text" id="sb-url" class="sb-key" placeholder="https://…" autocomplete="off" spellcheck="false"></div>
          <div class="sb-langrow">
            <button type="button" id="sb-btn-sv">🇸🇪 Svenska</button>
            <button type="button" id="sb-btn-en">🇺🇸 English</button>
          </div>
          <div class="sb-row"><label>Översätt sidans fält</label></div>
          <div class="sb-langrow">
            <button type="button" id="sb-btn-translate-sv" title="Skriver över sidans egna textfält med en svensk översättning">🇸🇪 → Svenska</button>
            <button type="button" id="sb-btn-translate-en" title="Skriver över sidans egna textfält med en amerikansk-engelsk översättning">🇺🇸 → English (US)</button>
          </div>
          <div class="sb-status" id="sb-status"></div>
        </div>
        <div class="sb-tab-panel" data-tab-panel="whatson">
          <div class="sb-row"><label>Period (startmånad)</label><select id="sb-whatson-month" class="sb-key"></select></div>
          <div class="sb-whatson-lang">
            <label class="sb-check"><input type="checkbox" id="sb-whatson-lang-sv" checked><span>🇸🇪 Svenska</span></label>
            <label class="sb-check"><input type="checkbox" id="sb-whatson-lang-en"><span>🇺🇸 English</span></label>
          </div>
          <div class="sb-langrow">
            <button type="button" id="sb-whatson-fetch">Hämta event</button>
          </div>
          <div class="sb-status" id="sb-whatson-status"></div>
          <div id="sb-whatson-checklist"></div>
          <div id="sb-whatson-guides"></div>
          <div class="sb-langrow">
            <button type="button" id="sb-whatson-write" title="Skriver de ikryssade eventen/guiden till sidans befintliga block — sparar INTE automatiskt">Skriv till sidan</button>
          </div>
        </div>
        <div class="sb-tab-panel" data-tab-panel="settings">
          <label class="sb-toggle-row">
            <span>🌙 Mörkt läge</span>
            <span class="sb-toggle">
              <input type="checkbox" id="sb-darkmode">
              <span class="sb-toggle-track"></span>
            </span>
          </label>
          <div class="sb-row"><label>Mistral API-nyckel</label><input type="text" id="sb-mkey" class="sb-key" placeholder="Mistral Bearer-nyckel" autocomplete="off" spellcheck="false"></div>
          <div class="sb-row"><label>Mistral agent-ID</label><input type="text" id="sb-magent" class="sb-key" placeholder="ag_..." autocomplete="off" spellcheck="false"></div>
          <div class="sb-row"><label>What's On agent-ID</label><input type="text" id="sb-magent-whatson" class="sb-key" placeholder="ag_..." autocomplete="off" spellcheck="false"></div>
          <div class="sb-row"><label>Kalender-API (valfritt override)</label><input type="text" id="sb-calendar-api" class="sb-key" placeholder="Lämnas tomt för standard-URL" autocomplete="off" spellcheck="false"></div>
          <div class="sb-setfieldbtns">
            <button type="button" id="sb-export-fields">⬇ Exportera fält</button>
            <button type="button" id="sb-import-pick">📂 Välj fil…</button>
          </div>
          <div class="sb-dropzone" id="sb-import-drop" title="Släpp en exportfil här">
            📥 Dra och släpp en exportfil här för att fylla i alla fält
            <input type="file" id="sb-import-file" accept=".json,application/json">
          </div>
        </div>
      </div>
      <div id="sb-logwrap"><div class="sb-loghdr">Logg <span><button type="button" id="sb-logjson">JSON</button><button type="button" id="sb-logcopy">📋</button><button type="button" id="sb-logclose">✕</button></span></div><div id="sb-log"></div></div>
    `;

    // Om inget agent-ID sparats sedan tidigare, skriv standardagenten till
    // lagringen direkt (inte bara till fältets visade värde) — annars visar
    // fältet rätt ID men GM_getValue('sidbot_magent') förblir tom tills
    // användaren råkar ändra och lämna fältet, vilket gjorde att "Fyll i
    // API-nyckel och agent-ID först" kunde visas trots ett synligt värde.
    if (!GM_getValue('sidbot_magent', '').trim()) GM_setValue('sidbot_magent', DEFAULT_MISTRAL_AGENT_ID);

    $('sb-mkey').value = GM_getValue('sidbot_mkey', '');
    $('sb-magent').value = GM_getValue('sidbot_magent', DEFAULT_MISTRAL_AGENT_ID);
    $('sb-mkey').addEventListener('change', () => { GM_setValue('sidbot_mkey', $('sb-mkey').value.trim()); backupSettingsToLS(); });
    $('sb-magent').addEventListener('change', () => { GM_setValue('sidbot_magent', $('sb-magent').value.trim()); backupSettingsToLS(); });

    // What's On-fliken: eget agent-ID (skilt från objectpage-agenten ovan)
    // och en valfri override för kalender-API:ets bas-URL (annars används
    // standard-endpointen för aktuell domän, se buildWhatsOnMonthOptions).
    $('sb-magent-whatson').value = GM_getValue('sidbot_magent_whatson', '');
    $('sb-calendar-api').value = GM_getValue('sidbot_calendar_api', '');
    $('sb-magent-whatson').addEventListener('change', () => { GM_setValue('sidbot_magent_whatson', $('sb-magent-whatson').value.trim()); backupSettingsToLS(); });
    $('sb-calendar-api').addEventListener('change', () => { GM_setValue('sidbot_calendar_api', $('sb-calendar-api').value.trim()); backupSettingsToLS(); });
    // ---- Export/Import av inställningsfält ----
    // Samma nycklar som fälten ovan. Exporten är en platt JSON-fil som kan
    // delas (innehåller API-nycklar — hantera därför filen som en hemlighet).
    const SETTINGS_FIELD_MAP = {
      sidbot_mkey:           { label: 'Mistral API-nyckel',   id: 'sb-mkey' },
      sidbot_magent:         { label: 'Mistral agent-ID',    id: 'sb-magent' },
      sidbot_magent_whatson: { label: "What's On agent-ID", id: 'sb-magent-whatson' },
      sidbot_calendar_api:   { label: 'Kalender-API',        id: 'sb-calendar-api' }
    };
    // Säkerhetskopiera + hydratera vid varje panelbygge, och backa upp på
    // nytt efter varje ändring/import så säkerhetskopian alltid är aktuell.
    restoreSettingsFromLS();
    backupSettingsToLS();
    function exportSettingsFile() {
      const data = {};
      Object.keys(SETTINGS_FIELD_MAP).forEach(k => { data[k] = GM_getValue(k, ''); });
      const blob = new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'editorbot-settings.json';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      vlog('Inställningar exporterade (editorbot-settings.json).', 'ok');
    }
    function importSettingsText(text) {
      let obj;
      try { obj = JSON.parse(text); } catch { vlog('Import: filen är inte giltig JSON.', 'err'); return; }
      let count = 0;
      Object.keys(SETTINGS_FIELD_MAP).forEach(k => {
        if (!(k in obj)) return;
        const val = String(obj[k] == null ? '' : obj[k]).trim();
        GM_setValue(k, val);
        const el = $(SETTINGS_FIELD_MAP[k].id);
        if (el) el.value = val;
        count++;
      });
      backupSettingsToLS();
      vlog('Import: ' + count + ' fält inlästa (' +
           Object.keys(SETTINGS_FIELD_MAP).filter(k => k in obj).map(k => SETTINGS_FIELD_MAP[k].label).join(', ') + ').', 'ok');
    }
    function importSettingsFile(file) {
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => importSettingsText(String(reader.result));
      reader.onerror = () => vlog('Import: kunde inte läsa filen.', 'err');
      reader.readAsText(file);
    }
    $('sb-export-fields').addEventListener('click', exportSettingsFile);
    const dropzone = $('sb-import-drop');
    $('sb-import-pick').addEventListener('click', () => $('sb-import-file').click());
    $('sb-import-file').addEventListener('change', e => { importSettingsFile(e.target.files[0]); e.target.value = ''; });
    ['dragenter', 'dragover'].forEach(ev => dropzone.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); dropzone.classList.add('hover'); }));
    ['dragleave', 'drop'].forEach(ev => dropzone.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); dropzone.classList.remove('hover'); }));
    dropzone.addEventListener('drop', e => {
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file && !/\.json$/i.test(file.name) && file.type !== 'application/json') {
        vlog('Import: förväntade en .json-fil, fick "' + file.name + '".', 'err');
        return;
      }
      importSettingsFile(file);
    });

    populateWhatsOnMonthDropdown($('sb-whatson-month'));
    // Språkval i WHAT'S ON-fliken: ömsesidigt uteslutande (radiobeteende på
    // kryssrutor, som Aron ville) — Svenska förvald. Valet styr agentens
    // språk, guidernas titelspråk och månadsnamnen, och sparas per nyckel.
    const langSv = $('sb-whatson-lang-sv'), langEn = $('sb-whatson-lang-en');
    langSv.checked = getWhatsOnLang() === 'sv';
    langEn.checked = getWhatsOnLang() === 'en';
    langSv.addEventListener('change', () => {
      if (langSv.checked) langEn.checked = false; else langSv.checked = true;
      setWhatsOnLang('sv');
      populateWhatsOnMonthDropdown($('sb-whatson-month'));
      vlog("WHAT'S ON: språk satt till Svenska.");
    });
    langEn.addEventListener('change', () => {
      if (langEn.checked) langSv.checked = false; else langEn.checked = true;
      setWhatsOnLang('en');
      populateWhatsOnMonthDropdown($('sb-whatson-month'));
      vlog("WHAT'S ON: språk satt till English.");
    });
    $('sb-whatson-fetch').addEventListener('click', handleWhatsOnFetch);
    $('sb-whatson-write').addEventListener('click', handleWhatsOnWrite);

    $('sb-darkmode').checked = getStoredTheme() === 'dark';
    $('sb-darkmode').addEventListener('change', () => {
      const theme = $('sb-darkmode').checked ? 'dark' : 'light';
      GM_setValue(THEME_KEY, theme);
      applyTheme(theme);
      vlog('Tema ändrat till ' + (theme === 'dark' ? 'mörkt' : 'ljust') + ' läge', 'ok');
    });

    document.querySelectorAll('.sb-tab-btn').forEach(btn => btn.addEventListener('click', () => {
      document.querySelectorAll('.sb-tab-btn').forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.sb-tab-panel').forEach(p => p.classList.toggle('active', p.dataset.tabPanel === btn.dataset.tab));
    }));

    document.querySelectorAll('#sb-headbtns button[data-m]').forEach(b => b.addEventListener('click', () => {
      const panel = $('sb-panel');
      if (panel) panel.className = b.dataset.m;
      document.querySelectorAll('#sb-headbtns button[data-m]').forEach(btn => btn.classList.toggle('on', btn.dataset.m === b.dataset.m));
      GM_setValue('sidbot_window_mode', b.dataset.m);
    }));

    $('sb-logbtn').addEventListener('click', () => { const w = $('sb-logwrap'); w.style.display = (w.style.display === 'none' ? 'flex' : 'none'); renderLog(); });
    $('sb-logclose').addEventListener('click', () => { $('sb-logwrap').style.display = 'none'; });

    $('sb-logcopy').addEventListener('click', async () => {
      const btn = $('sb-logcopy');
      const text = VLOG.map(e => e.line).join('\n');
      try { await navigator.clipboard.writeText(text); btn.textContent = '✓'; setTimeout(() => btn.textContent = '📋', 1200); }
      catch { btn.textContent = '✗'; setTimeout(() => btn.textContent = '📋', 1200); }
    });

    $('sb-logjson').addEventListener('click', async () => {
      const btn = $('sb-logjson');
      if (!lastData) { btn.textContent = 'Inget'; setTimeout(() => btn.textContent = 'JSON', 1200); return; }
      try { await navigator.clipboard.writeText(JSON.stringify(lastData, null, 2)); btn.textContent = '✓'; setTimeout(() => btn.textContent = 'JSON', 1200); }
      catch { btn.textContent = '✗'; setTimeout(() => btn.textContent = 'JSON', 1200); }
    });

    $('sb-mapbtn').addEventListener('click', () => {
      vlog('🔍 Kartlägger fält...');
      [...document.querySelectorAll('.DraftEditor-root')].forEach((root, i) => {
        const wrapper = root.closest('.w-field, .w-panel, [data-field]') || root.parentElement;
        const hidden = wrapper?.querySelector('input[type="hidden"], textarea');
        const label = wrapper?.querySelector('label')?.textContent?.trim() || '';
        vlog('  ' + (i+1) + ': id="' + (hidden?.id || '-') + '" label="' + label + '"');
      });
    });

    async function createSidePage(lang) {
      if (busy) return;
      const url = ($('sb-url').value || '').trim();
      // Läs direkt från fälten (inte GM_getValue) — annars missas ett
      // värde som användaren just skrivit in men inte lämnat fältet (blur)
      // för, eftersom det är 'change'-eventet som sparar till lagringen.
      const apiKey = ($('sb-mkey').value || '').trim();
      const agentId = ($('sb-magent').value || '').trim();
      GM_setValue('sidbot_mkey', apiKey);
      GM_setValue('sidbot_magent', agentId);

      if (!apiKey || !agentId) { setStatus('Fyll i API-nyckel och agent-ID först.', 'err'); return; }
      if (!url || !/^https?:\/\//i.test(url)) { setStatus('Ogiltig URL.', 'err'); return; }

      busy = true;
      $('sb-btn-sv').disabled = true;
      $('sb-btn-en').disabled = true;
      setStatus('Skickar till Mistral...', 'work');

      // Restaurang-kryssrutan är borttagen (booking_link används inte
      // längre) — is_restaurant skickas ändå som "false" eftersom agentens
      // egen systemprompt fortfarande förväntar sig fältet för att avgöra
      // om booking_link/booking_link_text ska fyllas i (aldrig, nu).
      const agentInput = 'URL: ' + url + '\nSPRÅK: ' + lang + '\nis_restaurant: false';

      try {
        let data = await callMistralAgentForJSON(apiKey, agentId, agentInput, 'original');

        // Blocklist-kontroll: max 2 iterationer totalt (originalsvaret +
        // högst en omskrivning). Om förbjudna ord/fraser kvarstår efter
        // omskrivningen accepteras svaret INTE — objektet flaggas för
        // manuell granskning istället för att fälten fylls i.
        let hits = checkBlocklist(data);
        let iteration = 1;
        while (hits.length > 0 && iteration < 2) {
          iteration++;
          vlog('Blocklist-kontroll: träff i försök ' + (iteration - 1) + ' — ' +
            hits.map(h => h.field + ': "' + h.match + '"').join(', '), 'warn');
          setStatus('Förbjudna ord hittade, ber agenten skriva om (försök ' + iteration + '/2)...', 'work');

          data = await callMistralAgentForJSON(apiKey, agentId, buildBlocklistRetryMessage(data, hits), 'omskrivning ' + iteration);
          hits = checkBlocklist(data);
        }

        if (hits.length > 0) {
          lastData = data;
          vlog('Blocklist-kontroll: träffar kvarstår efter ' + iteration + ' försök, flaggar för manuell granskning — ' +
            hits.map(h => h.field + ': "' + h.match + '"').join(', '), 'err');
          setStatus('❌ Flaggat för manuell granskning (förbjudna ord kvarstår)', 'err');
          return;
        }

        lastData = data;

        // Om agenten inte gav någon titel har den sannolikt inte kunnat
        // hämta/tolka sidan (notes brukar då förklara varför, t.ex.
        // "not_applicable", "could_not_fetch_url"). Utan detta visade
        // scriptet "Klar!" även när ALLA fält var tomma — det enda som
        // faktiskt syntes ifyllt var URL-fältet, som användaren skrivit
        // in själv och som scriptet aldrig rör.
        if (!data.title || !String(data.title).trim()) {
          const reason = data.notes && String(data.notes).trim() ? 'notes: "' + data.notes + '"' : 'inget titel-fält i svaret';
          vlog('Agenten gav ingen titel — fyller INTE i formuläret (' + reason + ').', 'err');
          setStatus('❌ Agenten gav ingen användbar data (' + reason + ')', 'err');
          return;
        }
        if (data.notes && String(data.notes).trim()) {
          vlog('OBS — agentens notes-fält: "' + data.notes + '". Dubbelkolla fälten extra noga.', 'warn');
        }

        const PLAIN_FIELDS = [
          ['title','id_title'],
          ['street_address','id_street_address'],
          ['zip_code','id_zip_code'],
          ['city','id_city'],
          ['phone','id_phone'],
          ['email','id_email'],
          ['external_link','id_external_link'],
          ['external_link_text','id_external_link_text'],
          ['related_events_title','id_related_events_title'],
          ['slug','id_slug'],
          ['seo_title','id_seo_title'],
          ['search_description','id_search_description'],
          ['og_title','id_og_title'],
          ['og_description','id_og_description'],
          ['twitter_title','id_twitter_title'],
          ['twitter_description','id_twitter_description'],
          ['canonical_link','id_canonical_link'],
          ['list_title','id_list_title'],
          ['go_live_at','id_go_live_at'],
          ['expire_at','id_expire_at']
        ];
        for (const [key, id] of PLAIN_FIELDS) if (data[key]) simulateInput($(id), data[key]);

        // Kryssrutor sätts explicit (även till false/av) om agenten anger dem,
        // till skillnad från textfälten ovan som bara skrivs om ett värde finns.
        const CHECKBOX_FIELDS = [
          ['robot_noindex','id_robot_noindex'],
          ['robot_nofollow','id_robot_nofollow'],
          ['show_in_menus','id_show_in_menus'],
          ['show_mega_menu','id_show_mega_menu']
        ];
        for (const [key, id] of CHECKBOX_FIELDS) if (Object.prototype.hasOwnProperty.call(data, key)) simulateInput($(id), data[key]);

        // rich_text/extra_info_text är Draftail-fält (React/Draft.js), inte
        // vanliga textfält — deras dolda <input> innehåller Draft.js egen
        // JSON-serialisering, inte klartext. simulateInput skrev tidigare en
        // vanlig sträng dit, vilket bara ändrade det dolda fältet utan att
        // den SYNLIGA editorn någonsin visade texten (sidan såg tom ut trots
        // att agenten gav en bra beskrivning). updateDraftail() går via
        // Draft.js egna React-props och uppdaterar editorn korrekt.
        if (data.rich_text) {
          const ok = await updateDraftail('id_rich_text', data.rich_text);
          vlog(ok ? 'Rich text ifyllt (' + data.rich_text.length + ' tecken).' : 'Rich text: kunde inte fyllas i, se felet ovan.', ok ? 'ok' : 'err');
        }
        const extraInfo = data.extra_info_text || data.extra_info;
        if (extraInfo) {
          const ok = await updateDraftail('id_extra_info_text', extraInfo);
          vlog(ok ? 'Extra info ifylld (' + extraInfo.length + ' tecken).' : 'Extra info: kunde inte fyllas i, se felet ovan.', ok ? 'ok' : 'err');
        }
        setStatus('Klar!', 'ok');
      } catch (e) { setStatus(e.message, 'err'); } finally { busy = false; $('sb-btn-sv').disabled = false; $('sb-btn-en').disabled = false; }
    }

    // Översätter sidans EGNA fält i-place (skriver över samma fält som
    // AI-skapandet fyller i ovan) — rör aldrig adress/kontakt/URL:er/slug/
    // datum/kryssrutor, se TRANSLATABLE_FIELDS. Körs oberoende av hur
    // fälten fick sitt nuvarande innehåll (AI-skapande eller manuell
    // redigering), och kan köras när som helst medan sidan är öppen.
    async function translatePage(targetLang) {
      if (busy) return;
      const apiKey = ($('sb-mkey').value || '').trim();
      if (!apiKey) { setStatus('Fyll i API-nyckel först (⚙️-fliken).', 'err'); return; }

      busy = true;
      $('sb-btn-sv').disabled = true;
      $('sb-btn-en').disabled = true;
      $('sb-btn-translate-sv').disabled = true;
      $('sb-btn-translate-en').disabled = true;

      const langName = TRANSLATE_LANG_NAME[targetLang];

      try {
        const source = readTranslatableFields();
        const nonEmptyKeys = Object.keys(source).filter(k => source[k]);
        if (nonEmptyKeys.length === 0) {
          setStatus('Inga ifyllda textfält att översätta.', 'err');
          return;
        }
        vlog('Översättning → ' + langName + ': läser ' + nonEmptyKeys.length + ' fält: ' + nonEmptyKeys.join(', '));
        setStatus('Skickar till Mistral (' + langName + ')...', 'work');

        let translated = await callTranslatorForJSON(apiKey, targetLang, JSON.stringify(source));

        // Samma blocklist-kontroll/omskrivnings-slinga som AI-skapandet:
        // max 2 iterationer totalt, acceptera ALDRIG ett svar med kvarstående
        // förbjudna ord/fraser — en "naturligt klandrande" översättning kan
        // annars smyga in klichéer som inte fanns i källtexten.
        let hits = checkBlocklist(translated);
        let iteration = 1;
        while (hits.length > 0 && iteration < 2) {
          iteration++;
          vlog('Översättning: blocklist-träff i försök ' + (iteration - 1) + ' — ' +
            hits.map(h => h.field + ': "' + h.match + '"').join(', '), 'warn');
          setStatus('Förbjudna ord i översättningen, försöker igen (' + iteration + '/2)...', 'work');
          translated = await callTranslatorForJSON(apiKey, targetLang, buildBlocklistRetryMessage(translated, hits));
          hits = checkBlocklist(translated);
        }

        if (hits.length > 0) {
          vlog('Översättning: blocklist-träffar kvarstår efter ' + iteration + ' försök — fälten lämnas ORÖRDA: ' +
            hits.map(h => h.field + ': "' + h.match + '"').join(', '), 'err');
          setStatus('❌ Osäker översättning (förbjudna ord kvarstår) — fälten orörda', 'err');
          return;
        }

        const written = await writeTranslatableFields(translated);
        vlog('Översättning klar (' + langName + '). Uppdaterade ' + written + ' fält.', 'ok');
        setStatus('✅ Översatt till ' + langName + ' (' + written + ' fält)', 'ok');
      } catch (e) {
        vlog('Översättning: fel — ' + e.message, 'err');
        setStatus('❌ ' + e.message, 'err');
      } finally {
        busy = false;
        $('sb-btn-sv').disabled = false;
        $('sb-btn-en').disabled = false;
        $('sb-btn-translate-sv').disabled = false;
        $('sb-btn-translate-en').disabled = false;
      }
    }

    $('sb-btn-sv').addEventListener('click', () => createSidePage('sv'));
    $('sb-btn-en').addEventListener('click', () => createSidePage('en'));
    $('sb-btn-translate-sv').addEventListener('click', () => translatePage('sv'));
    $('sb-btn-translate-en').addEventListener('click', () => translatePage('en'));

    function setStatus(msg, kind) {
      const s = document.getElementById('sb-status');
      if (s) {
        s.textContent = msg;
        s.className = 'sb-status ' + (kind || 'work');
        s.style.display = 'block';
      }
    }

    let mode = GM_getValue('sidbot_window_mode', 'min');
    if (!['min', 'max'].includes(mode)) mode = 'min';
    document.querySelectorAll('#sb-headbtns button[data-m]').forEach(b => b.classList.toggle('on', b.dataset.m === mode));
    vlog('EditorBot v' + SCRIPT_VERSION + ' startad');
  }

  // ===== INIT =====
  // Temat appliceras innan bar/panel byggs, oavsett vilken av dem sidan
  // visar, så samma mörkt/ljust-val gäller överallt.
  injectThemeOverrideStyle();
  applyTheme(getStoredTheme());
  // Hydrera GM-lagringen från localStorage-säkerhetskopian vid VARJE
  // sidladdning, även på EventPortal-sidor där buildPanel() aldrig körs.
  try { restoreSettingsFromLS(); } catch {}
  try { backupSettingsToLS(); } catch {}

  // "Synka utvalda event"-listen ska ENDAST visas på de 4 kända
  // landningssidorna (Start SE/EN, S&G, S&D) — dvs. exakt sidans ID matchar
  // EP_PAGE_MAPPING, inte "vilken edit-sida som helst" och inte en
  // delsträngsträff mot ett annat sid-ID (se epPageIdFromPath).
  const epPageId = epPageIdFromPath(location.pathname);
  const isEventPortalPage = epPageId !== null && Object.values(EP_PAGE_MAPPING).includes(epPageId);
  if (isEventPortalPage) {
    buildEventportorBar();
  } else {
    buildPanel();
  }
  // Toppraden i bildvyn behövs på ALLA sidor — bilduppladdningsmodalen
  // kan öppnas var som helst i CMS:et.
  buildImageHandlingBar();

  // WHAT'S ON: klick på en sektionsrubrik fäller in/ut sektionens lista
  // (delegerad lyssnare så den överlever att checklisten ritas om).
  document.addEventListener('click', e => {
    const title = e.target.closest('.sb-whatson-section-title');
    if (title) {
      const wrap = title.parentElement;
      if (wrap && wrap.classList.contains('sb-whatson-collapsible')) {
        wrap.classList.toggle('sb-collapsed');
      }
    }
  });
})();
