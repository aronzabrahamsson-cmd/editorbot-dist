// ==UserScript==
// @name         EditorBot
// @namespace    visitstockholm.sidbot
// @version      4.7
// @description  v4.7: Ny programmatisk blocklist-kontroll på agentens JSON-svar innan fälten fylls i — söker igenom alla strängfält utom "notes" (normaliserat: NFC, lowercase, kollapsade mellanslag) efter klichéord/fraser (sv+en), med undantag för verifierade delar av objektets eget namn. Vid träff skickas hela föregående JSON tillbaka till agenten med begäran om omskrivning enligt BLOCKLISTE-KONTROLL i systemprompten (max 1 omskrivningsförsök). Kvarstår träffar efter det fylls inga fält i — objektet flaggas istället för manuell granskning i statusraden och loggen. v4.6: Fixat att "Fyll i API-nyckel och agent-ID först" kunde visas trots synligt ifyllda fält (standardagenten sparades aldrig, och kontrollen läste bara sparad data, inte fältens faktiska innehåll). Mörkt läge-kryssrutan är nu en riktig växlingsknapp (var snedvriden/ful som kryssruta), och textfälten tvingas nu alltid ha rätt bakgrund/textfärg (vitt/svart i ljust läge) med !important så CMS:ets egna stilar inte vinner. v4.5: EditorBot-panelen har nu en egen ⚙️-flik separat från huvudfliken, med ett mörkt/ljust temaval och API-nyckel/agent-ID-fälten. Temat sparas mellan sessioner och gäller både panelen och "Synka utvalda event"-listen. v4.4: Fixat bugg där "Synka utvalda event"-listen visades på fel sidor (t.ex. /objectpage/1474/) pga en delsträngsmatchning ("7" i S&D:s ID matchade siffran i "1474"). Listen visas nu bara på de 4 avsedda landningssidorna (Start SE/EN, S&G, S&D) — alla andra sidor (inklusive nya objectpage) visar EditorBot-panelen. v4.3: Objectpage-panelen fyller nu i alla vanliga textfält och kryssrutor (slug, canonical_link, twitter_title/description, related_events_title, go_live_at/expire_at, robot_noindex/nofollow, show_in_menus/show_mega_menu) från Mistral-agentens svar, inte bara ett litet urval. Fixat en bugg där extra_info skrevs till ett icke-existerande fält-ID. Mistral agent-ID förifyllt med standardagenten.
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
  const DEFAULT_MISTRAL_AGENT_ID = 'ag_01a00f03d056722bb5310f4738447535';
  const THEME_KEY = 'sidbot_theme';

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

  async function callMistralAgentForJSON(apiKey, agentId, inputText) {
    const resp = await gmPost(MISTRAL_CONV,
      { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      { agent_id: agentId, inputs: inputText, store: false });
    const text = (resp.outputs?.[0]?.content || resp.messages?.[0]?.content || '').trim();
    const data = extractJSON(text);
    if (!data) throw new Error('Kunde inte tolka JSON.');
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
      return false;
    }

    let searchInput = modal.querySelector('input[type="text"], input[type="search"]');
    if (!searchInput) {
      await wait(500);
      searchInput = modal.querySelector('input[type="text"], input[type="search"]');
    }
    if (!searchInput) {
      vlog('Inget sökfält hittat!', 'err');
      await closeChooserModal();
      return false;
    }

    // Rensa söktermen. cleanTerm (hela titeln) används för att POÄNGSÄTTA
    // träffarna, men CMS:ets sökfunktion klarar inte att söka på hela långa
    // titlar (för många ord ger inga träffar) — så det vi faktiskt SKRIVER i
    // sökfältet är bara de första 1–2 orden.
    const cleanTerm = cleanDisplayText(searchTerm);
    const queryWords = cleanTerm.split(/\s+/).filter(Boolean);
    const searchQuery = queryWords.length <= 1 ? queryWords.join(' ') : queryWords.slice(0, 2).join(' ');
    vlog('Sökfält hittat, fyller i: "' + searchQuery + '" (av hela titeln "' + cleanTerm + '")');

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
        return false;
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
          return true;
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
          return true;
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
          return true;
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
        vlog(`Resultaten har stabiliserats, accepterar bästa träffen "${bestHit.text}" (poäng: ${bestHit.score})`, 'ok');
        bestHit.element.click();
        await wait(800);

        if (await verifyFieldFilled(blockIdx, rowIndex)) {
          await closeChooserModal();
          return true;
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
    return false;
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

        const ok = await epSelectInChooserModal(ev.displayText, blockIdx, row.index);
        if (ok) {
          successfulFills++;
          vlog('Rad ' + (i+1) + ' ifylld', 'ok');
        } else {
          vlog('Kunde inte fylla rad ' + (i+1), 'err');
        }
        await wait(1000); // Längre väntetid mellan varje event
      }

      // UPPPDATERAT STATUSMEDDELANDE
      if (successfulFills === validEvents.length) {
        vlog('KLART! Alla ' + successfulFills + ' event ifyllda', 'ok');
        setEpStatus('✅ ' + successfulFills + '/' + validEvents.length + ' event ifyllda');
      } else if (successfulFills > 0) {
        vlog('Delvis framgång: ' + successfulFills + '/' + validEvents.length + ' event ifyllda', 'warn');
        setEpStatus('⚠️ ' + successfulFills + '/' + validEvents.length + ' event ifyllda');
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
    const events = [];

    for (const si of subIdxs) {
      const valEl = $(pfx + 'events-' + si + '-value');
      if (!valEl || !valEl.value) continue;

      const orderEl = document.querySelector('input[name="' + pfx + 'events-' + si + '-order"]');
      const wrapper = valEl.closest('li, [data-contentpath]') || valEl.parentElement;

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

      events.push({
        id: valEl.value,
        order: orderEl ? parseInt(orderEl.value, 10) : 0,
        displayText: displayText || 'Event ' + (events.length + 1)
      });
    }

    events.sort((a, b) => a.order - b.order);
    vlog('Kopierade ' + events.length + ' event', 'ok');

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
      <span class="ep-title">Synka utvalda event</span>
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

    vlog('Synka utvalda event v4.7 startad', 'ok');
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
        <div class="t">EditorBot</div>
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
        let data = await callMistralAgentForJSON(apiKey, agentId, agentInput);

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

          data = await callMistralAgentForJSON(apiKey, agentId, buildBlocklistRetryMessage(data, hits));
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

    $('sb-btn-sv').addEventListener('click', () => createSidePage('sv'));
    $('sb-btn-en').addEventListener('click', () => createSidePage('en'));

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
    vlog('EditorBot v4.7 startad');
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
