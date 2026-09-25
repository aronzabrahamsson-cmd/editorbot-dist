// ==UserScript==
// @name         EditorBot
// @namespace    visitstockholm.sidbot
// @version      4.15
// @description  v4.15: Två nya knappar, "🇸🇪 → Svenska" och "🇺🇸 → English (US)", översätter objektsidans egna textfält i-place (title, rich_text, extra_info_text, seo_title, search_description, og_title/description, twitter_title/description, list_title, external_link_text, booking_link_text, related_events_title) — rör aldrig adress/kontakt/URL:er/slug/datum/kryssrutor. Amerikansk engelska, inte brittisk. Samma blocklist-kontroll/omskrivnings-slinga som AI-skapandet skyddar mot att en "naturlig" översättning smyger in klichéer. Portade även Draftail-läsning/skrivning (readDraftailText/mountDraftail/updateDraftail) från eventbot för att korrekt uppdatera rich_text/extra_info_text-fälten (används av översättningen; AI-skapandets egen ifyllning av dessa fält väntar på en separat fix). v4.14: Ny bildautomation — när en bild väljs manuellt i bilduppladdningsmodalen (featured_image/og_image/twitter_image, samma modal som eventbot använder) genereras alt-text (sv/en) automatiskt via pixtral-synmodellen, och kredit/rättighetsdatum (dagens datum + 5 år) fylls i. Kräver sparad Mistral API-nyckel (⚙️-fliken). v4.10: Mörkblått versionsmärke bredvid rubriken i båda widgetarna, så man alltid ser exakt vilken version som körs. v4.9: Fix för web_search-svar som inte gick att tolka som JSON. v4.8: Detaljerad loggning av allt som skickas/tas emot från Mistral, plus fix för falskt "Klar!" när agenten inte gav någon användbar data. Äldre versioner: se git-historiken.
// @match        https://www.visitstockholm.com/cms/pages/add/main/objectpage/*
// @match        https://www.visitstockholm.se/cms/pages/add/main/objectpage/*
// @match        https://www.visitstockholm.com/cms/pages/*/edit/*
// @match        https://www.visitstockholm.se/cms/pages/*/edit/*
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

  // Enda källan till versionsnumret — matcha alltid mot @version-headern
  // överst i filen. Används i loggens startrad och i versionsmärket i
  // widgetarnas rubrik (mörkblå text/bakgrund, oberoende av tema, så man
  // alltid kan se på skärmen exakt vilken version som körs).
  const SCRIPT_VERSION = '4.15';
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
  // använder /event/ (singular), .com använder /events/ (plural) — resten
  // av sökvägen är identisk. Lägger till saknade systerlänkar i slutet av
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
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST', url, headers, data: JSON.stringify(body),
        onload: r => {
          if (r.status === 401) return reject(new Error('Mistral: 401'));
          if (r.status === 422) return reject(new Error('Mistral: 422'));
          if (r.status === 429) return reject(new Error('Mistral: 429'));
          if (r.status < 200 || r.status >= 300) return reject(new Error('HTTP ' + r.status));
          try { resolve(JSON.parse(r.responseText)); } catch { reject(new Error('Ogiltig JSON')); }
        },
        onerror: () => reject(new Error('Nätverksfel')),
        ontimeout: () => reject(new Error('Timeout')), timeout: 120000
      });
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
    ['booking_link_text', 'id_booking_link_text', 'plain'],
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
  async function fetchAltTextFromImageFile(file, apiKey) {
    if (!file || !apiKey) return null;
    try {
      const dataUrl = await fileToDataURL(file);
      const body = {
        model: 'pixtral-12b-2409',
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
      if (data && (data.alttext_sv || data.alttext_en)) return data;
    } catch (e) {
      vlog('Pixtral alt-text-anrop misslyckades: ' + e.message, 'err');
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
    if (!epLog && !sbLog) return;
    const logContent = VLOG.map(e => `<div class="sb-logline ${e.kind}">${esc(e.line)}</div>`).join('');
    if (epLog) epLog.innerHTML = logContent;
    if (sbLog) sbLog.innerHTML = logContent;
    if (epLog) epLog.scrollTop = epLog.scrollHeight;
    if (sbLog) sbLog.scrollTop = sbLog.scrollHeight;
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
  // textfält: det synliga fältet är en React/Draft.js-editor, och det
  // dolda <input>:et (id_rich_text etc.) innehåller Draft.js egen
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

  function getDraftProps(root) {
    const instKey = Object.keys(root).find(k => k.startsWith('__reactInternalInstance$'));
    let node = instKey ? root[instKey] : null;
    let hops = 0;
    while (node && hops < 30) {
      const mp = node.memoizedProps;
      if (mp && mp.onChange && mp.editorState) return mp;
      node = node.return || node._debugOwner || null;
      hops++;
    }
    return null;
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
        vlog('Draftail: hittade fältet ' + fieldId + ' men inte dess React-props — fältet lämnas orört.', 'err');
        return false;
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
      .replace(/[\"'‘’“”]/g, '')  // Ta bort citattecken
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
    // sökfältet är bara de första 1–2 orden.
    const cleanTerm = cleanDisplayText(searchTerm);
    const queryWords = cleanTerm.split(/\s+/).filter(Boolean);
    let searchQuery = queryWords.length <= 1 ? queryWords.join(' ') : queryWords.slice(0, 2).join(' ');
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
      // bläddringsknappar) som råkade poängsättas positivt — det var
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
      right: 10px !important;
      z-index: 999998 !important;
      width: 500px;
      max-height: 400px;
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
    mini.textContent = '📇';
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
    #sb-logwrap {
      display: none;
      flex-direction: column;
      border-top: 1px solid var(--vd-line);
      max-height: 220px;
      background: var(--vd-bg2);
      flex-shrink: 0;
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
        <button type="button" class="sb-tab-btn" data-tab="settings" title="Inställningar">⚙️</button>
      </div>
      <div id="sb-scroll">
        <div class="sb-tab-panel active" data-tab-panel="main">
          <div class="sb-row"><label>Sida-URL</label><input type="text" id="sb-url" class="sb-key" placeholder="https://…" autocomplete="off" spellcheck="false"></div>
          <label class="sb-check"><input type="checkbox" id="sb-restaurant"> 🍽️ Restaurang</label>
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
    $('sb-mkey').addEventListener('change', () => GM_setValue('sidbot_mkey', $('sb-mkey').value.trim()));
    $('sb-magent').addEventListener('change', () => GM_setValue('sidbot_magent', $('sb-magent').value.trim()));

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
      const isRestaurant = $('sb-restaurant').checked;
      GM_setValue('sidbot_mkey', apiKey);
      GM_setValue('sidbot_magent', agentId);

      if (!apiKey || !agentId) { setStatus('Fyll i API-nyckel och agent-ID först.', 'err'); return; }
      if (!url || !/^https?:\/\//i.test(url)) { setStatus('Ogiltig URL.', 'err'); return; }

      busy = true;
      $('sb-btn-sv').disabled = true;
      $('sb-btn-en').disabled = true;
      setStatus('Skickar till Mistral...', 'work');

      const agentInput = 'URL: ' + url + '\nSPRÅK: ' + lang + '\nis_restaurant: ' + isRestaurant;

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

        if (isRestaurant && data.booking_link) simulateInput($('id_booking_link'), data.booking_link);
        if (isRestaurant && data.booking_link_text) simulateInput($('id_booking_link_text'), data.booking_link_text);
        if (data.rich_text) simulateInput($('id_rich_text'), data.rich_text);
        const extraInfo = data.extra_info_text || data.extra_info;
        if (extraInfo) simulateInput($('id_extra_info_text'), extraInfo);
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
        // förbjudna ord/fraser — en "naturligt klingande" översättning kan
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
})();
