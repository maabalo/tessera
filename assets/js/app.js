/* ==========================================================================
   Tessera — app.js
   --------------------------------------------------------------------------
   All app behaviour. Written as one plain script (no ES modules) so the app
   runs straight from file:// with no server. The QR encoder itself lives in
   qrcode.js (loaded first) and is used here as QrEncoder.encode().

   Data model:
       state.type     'text' | 'wifi' | 'contact' | 'email' | 'phone' | 'sms'
       state.content  { text: {…}, wifi: {…}, … }   fields for EVERY type,
                      so switching type never loses what was typed
       state.style    { ecc, fg, bg, transparent, shape, margin, pngSize, logo }
       state.logoImage  the user's own center image (a small PNG data URL), kept
                        even when another symbol is chosen
       state.code     the current code { qr, text, notes, type } or null

   Flow: any edit → onChange() → renderCode() on the next frame
         (payload → QR matrix → SVG preview, info, warnings, scan check)
         and an autosave 400 ms later.

   TABLE OF CONTENTS
     01  Settings & constants
     02  Content types (what goes inside each kind of code)
     03  DOM references
     04  Small helpers
     05  State, saved data & autosave
     06  Form: content fields
     07  Form: style controls & center image
     08  Building the code
     09  Drawing (SVG path, preview, canvas)
     10  Warnings & contrast
     11  Scan check (the browser's own barcode reader)
     12  Export (PNG, SVG, copy)
     13  Dialogs
     14  Toast & screen-reader announcements
     15  Theme
     16  Keyboard shortcuts
     17  Init
   ========================================================================== */
(function () {
  'use strict';

  /* ==========================================================================
     01  SETTINGS & CONSTANTS
     ========================================================================== */
  const STORAGE_KEYS = {
    theme: 'tessera-theme', // also read by the inline script in index.html
    state: 'tessera-state',
  };

  const SAVE_DELAY_MS = 400; // autosave waits this long after the last change
  const SCAN_DELAY_MS = 350; // scan check waits until typing pauses
  const TOAST_MS = 2400;
  const PAYLOAD_PREVIEW_CHARS = 3000; // "what's inside the code" shows at most this much

  const THEMES = ['auto', 'light', 'dark'];
  /** Browser-bar color (meta theme-color) for a manually chosen theme. Matches --surface. */
  const THEME_BAR_COLORS = { light: '#ffffff', dark: '#101317' };
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const ECC_LEVELS = ['L', 'M', 'Q', 'H'];
  const SHAPES = ['square', 'rounded', 'dots'];
  const PNG_SIZES = [256, 512, 1024, 2048];
  const MARGIN_RANGE = { min: 0, max: 8, recommended: 4 };
  const HEX_COLOR = /^#[0-9a-f]{6}$/i;
  // No ? & # etc.: in a mailto: link they would start hidden extras such as "?bcc=…".
  const EMAIL_PATTERN = /^[^\s@?&#,;:<>"/\\]+@[^\s@?&#,;:<>"/\\]+\.[^\s@?&#,;:<>"/\\]+$/;

  /** The encoder from qrcode.js (undefined only if that file failed to load — see init). */
  const QrEncoder = globalThis.QrEncoder;
  /** Longest text worth keeping: nothing longer fits in any QR code. Also caps saved data. */
  const MAX_FIELD_LENGTH = QrEncoder ? QrEncoder.MAX_CHARACTERS : 7089;

  const DEFAULT_STYLE = Object.freeze({
    ecc: 'M',
    fg: '#000000',
    bg: '#ffffff',
    transparent: false,
    shape: 'square',
    margin: MARGIN_RANGE.recommended,
    pngSize: 1024,
    logo: 'none',
  });

  const GOOD_CONTRAST = 4; // below this ratio, some scanners struggle
  const DENSE_VERSION = 15; // from this version on, codes need to be printed large
  // Tested in Chrome's reader: dots + a center symbol failed from version 17, and some symbols
  // with square/rounded modules from version 27 (all passed up to 24). Above these versions the app warns.
  const DOTS_WITH_SYMBOL_MAX_VERSION = 15;
  const SYMBOL_MAX_VERSION = 24;
  const SCAN_MODULE_PX = 6; // module size of the image used for the scan check

  // Center symbol (sections 07 and 09).
  const LOGO_CHOICES = [
    'none',
    'auto',
    'wifi',
    'link',
    'phone',
    'mail',
    'user',
    'sms',
    'heart',
    'star',
    'image',
  ];
  const LOGO_ECC = 'H'; // the symbol hides some modules, so the strongest error correction is used
  const LOGO_AREA = 0.22; // width of the cleared square, as a share of the code (≈5% of the modules)
  const LOGO_MAX_SIDE = 17; // …but never wider than this many modules: big codes scanned better (tested)
  const LOGO_PADDING = 0.12; // blank space inside that square, around the symbol
  const LOGO_STROKE = 2.25; // line width of the built-in symbols, on their 24-unit grid
  const LOGO_IMAGE_PX = 256; // own images are shrunk to this so they can be saved
  const MAX_LOGO_FILE_BYTES = 10000000;
  const LOGO_FILE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  const SAVED_IMAGE_PATTERN = /^data:image\/png;base64,[a-z0-9+/]+=*$/i;
  const MAX_SAVED_IMAGE_CHARS = 400000;
  const XLINK_NS = 'http://www.w3.org/1999/xlink';

  /** Built-in symbols: line drawings on a 24×24 grid (the same shapes as the sprite icons). */
  const LOGO_ICONS = {
    wifi: 'M2 8.8a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 20h.01',
    link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
    phone:
      'M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z',
    mail: 'M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM3 7l9 6 9-6',
    user: 'M16 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0zM4 21a8 8 0 0 1 16 0',
    sms: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
    heart:
      'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z',
    star: 'M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5-4.8-4.6 6.6-.9z',
  };

  /** "match the type" uses this symbol for each content type. */
  const TYPE_LOGOS = {
    text: 'link',
    wifi: 'wifi',
    contact: 'user',
    email: 'mail',
    phone: 'phone',
    sms: 'sms',
  };

  // Shape geometry, in modules (1 = one module).
  const DOT_RADIUS = 0.42;
  const ROUNDED_RADIUS = 0.3;
  const EYE_RADII = [2, 1.4, 0.9]; // outer ring, inner hole, centre of each finder "eye"

  /* ==========================================================================
     02  CONTENT TYPES
     Every type has default fields and build(fields), which returns
       { text, notes? }  the exact text stored in the code (+ optional warnings)
       { missing }       a message saying what still has to be filled in
     The formats are the ones phone cameras understand (Wi-Fi: WIFI:…;;,
     contact: vCard 3.0, email: mailto:, phone: tel:, SMS: SMSTO:).
     ========================================================================== */
  const DEFAULT_CONTENT = Object.freeze({
    text: { text: '' },
    wifi: { ssid: '', password: '', security: 'WPA', hidden: false },
    contact: { first: '', last: '', phone: '', email: '', org: '', title: '', url: '' },
    email: { to: '', subject: '', body: '' },
    phone: { number: '' },
    sms: { number: '', message: '' },
  });

  const WIFI_SECURITY = ['WPA', 'WEP', 'nopass'];
  /** How the limit is counted for each encoding mode (see QrEncoder.capacity). */
  const CAPACITY_UNITS = { numeric: 'digits', alphanumeric: 'characters', byte: 'bytes' };
  /** Fields that are never written to localStorage. */
  const UNSAVED_FIELDS = { wifi: ['password'] };

  const CONTENT_TYPES = {
    text: { label: 'link or text', build: buildTextPayload, fileName: (f) => f.text },
    wifi: { label: 'Wi-Fi network', build: buildWifiPayload, fileName: (f) => f.ssid },
    contact: { label: 'contact card', build: buildContactPayload, fileName: contactName },
    email: { label: 'email', build: buildEmailPayload, fileName: (f) => f.to },
    phone: { label: 'phone number', build: buildPhonePayload, fileName: (f) => f.number },
    sms: { label: 'text message', build: buildSmsPayload, fileName: (f) => f.number },
  };

  /** Link / text: stored as typed (minus surrounding spaces). */
  function buildTextPayload(fields) {
    const text = fields.text.trim();
    return text ? { text } : { missing: 'Type a link or some text to make a code' };
  }

  /** Wi-Fi: WIFI:T:WPA;S:name;P:password;H:true;; */
  function buildWifiPayload(fields) {
    if (!fields.ssid.trim()) return { missing: 'Enter the network name (SSID) to make a code' };
    const parts = [`T:${fields.security}`, `S:${escapeWifi(fields.ssid)}`];
    const needsPassword = fields.security !== 'nopass';
    if (needsPassword && fields.password) parts.push(`P:${escapeWifi(fields.password)}`);
    if (fields.hidden) parts.push('H:true');
    const notes = [];
    if (needsPassword && !fields.password) notes.push('No password entered — phones will ask for it.');
    return { text: `WIFI:${parts.join(';')};;`, notes };
  }

  /** Contact: a vCard 3.0 (lines end in CRLF, as the format requires). */
  function buildContactPayload(fields) {
    const f = trimFields(fields);
    const displayName = contactName(f) || f.phone || f.email;
    if (!displayName) return { missing: 'Enter at least a name, company, phone or email' };
    const lines = ['BEGIN:VCARD', 'VERSION:3.0', `N:${escapeVcard(f.last)};${escapeVcard(f.first)};;;`];
    lines.push(`FN:${escapeVcard(displayName)}`);
    const optional = [
      ['ORG', f.org],
      ['TITLE', f.title],
      ['TEL;TYPE=CELL', f.phone],
      ['EMAIL', f.email],
      ['URL', f.url],
    ];
    optional.forEach(([name, value]) => {
      if (value) lines.push(`${name}:${escapeVcard(value)}`);
    });
    lines.push('END:VCARD');
    return { text: lines.join('\r\n') };
  }

  /** Email: mailto:address?subject=…&body=… */
  function buildEmailPayload(fields) {
    const to = fields.to.trim();
    if (!to) return { missing: 'Enter the email address to send to' };
    if (!EMAIL_PATTERN.test(to)) return { missing: 'Check the email address (name@example.com)' };
    const params = [];
    if (fields.subject.trim()) params.push(`subject=${encodeURIComponent(fields.subject.trim())}`);
    if (fields.body.trim()) params.push(`body=${encodeURIComponent(fields.body.trim())}`);
    return { text: `mailto:${to}${params.length ? `?${params.join('&')}` : ''}` };
  }

  /** Phone: tel:+15550100199 */
  function buildPhonePayload(fields) {
    const number = cleanPhone(fields.number);
    if (!/\d/.test(number)) return { missing: 'Enter a phone number to make a code' };
    return { text: `tel:${number}`, notes: phoneNotes(number) };
  }

  /** SMS: SMSTO:+15550100199:message */
  function buildSmsPayload(fields) {
    const number = cleanPhone(fields.number);
    if (!/\d/.test(number)) return { missing: 'Enter the phone number to text' };
    const message = fields.message.trim();
    return { text: `SMSTO:${number}${message ? `:${message}` : ''}`, notes: phoneNotes(number) };
  }

  /** Warn about numbers without a country code (they only work inside one country). */
  function phoneNotes(number) {
    return number.startsWith('+')
      ? []
      : ['No country code (like +1 or +44) — it may only work in your country.'];
  }

  /** "Alex Rivera", or the company when there is no name. */
  function contactName(fields) {
    return `${fields.first.trim()} ${fields.last.trim()}`.trim() || fields.org.trim();
  }

  /** Wi-Fi format: \ ; , : and " must be escaped with a backslash. */
  function escapeWifi(value) {
    return value.replace(/([\\;,:"])/g, '\\$1');
  }

  /** vCard format: backslash, comma, semicolon and line breaks must be escaped. */
  function escapeVcard(value) {
    return value
      .replace(/\\/g, '\\\\')
      .replace(/\r?\n/g, '\\n')
      .replace(/([,;])/g, '\\$1');
  }

  /** Keep digits and a leading "+": "+1 (555) 010-0199" → "+15550100199". */
  function cleanPhone(value) {
    return value.replace(/[^\d+]/g, '').replace(/(?!^)\+/g, '');
  }

  /** Copy of a fields object with every string trimmed. */
  function trimFields(fields) {
    const result = {};
    Object.entries(fields).forEach(([key, value]) => {
      result[key] = typeof value === 'string' ? value.trim() : value;
    });
    return result;
  }

  /* ==========================================================================
     03  DOM REFERENCES
     Every id used here exists in index.html.
     ========================================================================== */
  const byId = (id) => document.getElementById(id);

  const els = {
    // Top bar
    helpBtn: byId('helpBtn'),
    themeBtn: byId('themeBtn'),
    // Content card
    contentTitle: byId('contentTitle'),
    typePicker: document.querySelector('.type-picker'),
    typePanels: document.querySelectorAll('.type-panel'),
    contentFields: document.querySelectorAll('[data-type]'),
    textInput: byId('textInput'),
    httpsTip: byId('httpsTip'),
    httpsBtn: byId('httpsBtn'),
    wifiPassword: byId('wifiPassword'),
    wifiShowBtn: byId('wifiShowBtn'),
    clearBtn: byId('clearBtn'),
    // Preview card
    qrFrame: byId('qrFrame'),
    qrMessage: byId('qrMessage'),
    qrInfo: byId('qrInfo'),
    scanStatus: byId('scanStatus'),
    warningList: byId('warningList'),
    pngBtn: byId('pngBtn'),
    svgBtn: byId('svgBtn'),
    copyBtn: byId('copyBtn'),
    payloadText: byId('payloadText'),
    // Style card
    styleCard: document.querySelector('.card--style'),
    styleFields: document.querySelectorAll('[data-style]'),
    fgHex: byId('fgHex'),
    bgHex: byId('bgHex'),
    contrastText: byId('contrastText'),
    marginValue: byId('marginValue'),
    swapBtn: byId('swapBtn'),
    eccHint: byId('eccHint'),
    logoUpload: byId('logoUpload'),
    logoChooseBtn: byId('logoChooseBtn'),
    logoFileName: byId('logoFileName'),
    logoFile: byId('logoFile'),
    resetStyleBtn: byId('resetStyleBtn'),
    // Overlays
    helpDialog: byId('helpDialog'),
    toast: byId('toast'),
    announcer: byId('announcer'),
  };

  /** The error-correction hint as written in index.html (restored when no symbol forces H). */
  const ECC_HINT = els.eccHint.textContent.trim();

  /* ==========================================================================
     04  SMALL HELPERS
     ========================================================================== */
  /**
   * Create an element with an optional class and text (text is never parsed as HTML).
   * @param {string} tag
   * @param {string} [className]
   * @param {string} [text]
   */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /** Create an SVG element with attributes. */
  function svgEl(tag, attributes = {}) {
    const node = document.createElementNS(SVG_NS, tag);
    Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, String(value)));
    return node;
  }

  /**
   * <svg class="icon"><use href="#i-NAME"/></svg> (icons live in the sprite in index.html).
   * @param {string} name
   * @param {string} [extraClass] e.g. "icon--status"
   */
  function svgIcon(name, extraClass = '') {
    const className = `icon ${extraClass}`.trim();
    const svg = svgEl('svg', { class: className, 'aria-hidden': 'true', focusable: 'false' });
    svg.append(svgEl('use', { href: `#i-${name}` }));
    return svg;
  }

  /** True for {…} objects (not arrays, not null). */
  function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  /** localStorage read that never throws (blocked storage → null). */
  function readStorage(key) {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      console.warn('Tessera: storage is not available', error);
      return null;
    }
  }

  /** localStorage write. Returns false when storage is blocked or full. */
  function writeStorage(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (error) {
      console.warn('Tessera: could not save', error);
      return false;
    }
  }

  /** "Home Network!" → "home-network" (safe in file names, max 40 characters). */
  function slugify(text) {
    return String(text)
      .toLowerCase()
      .replace(/^[a-z]+:\/\//, '') // drop "https://"
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '');
  }

  /** Number of UTF-8 bytes in a string (what the QR code actually stores). */
  function byteLength(text) {
    return new TextEncoder().encode(text).length;
  }

  /** 1234 → "1,234" */
  function formatNumber(value) {
    return value.toLocaleString('en-US');
  }

  /* ==========================================================================
     05  STATE, SAVED DATA & AUTOSAVE
     ========================================================================== */
  const state = {
    theme: 'auto',
    type: 'text',
    content: cloneDefaults(),
    style: { ...DEFAULT_STYLE },
    code: null, // { qr, text, notes, type } of the code on screen
    renderFrame: 0,
    saveTimer: 0,
    scanTimer: 0,
    scanRun: 0, // increases with each scan check, so a slow old result is ignored
    hasRendered: false, // the first render (page load) is not announced
    saveWarned: false, // "can't save" is shown only once
    otherTabWarned: false, // "open in another tab" is shown only once
    scanRisk: false, // true when style warnings suggest phones may struggle (section 10)
    logoImage: '', // own center image as a PNG data URL ('' = none yet)
    logoImg: null, // the same image, decoded and ready to draw
    logoName: '', // its file name, shown next to "choose image"
  };

  /** A fresh, editable copy of DEFAULT_CONTENT. */
  function cloneDefaults() {
    const result = {};
    Object.entries(DEFAULT_CONTENT).forEach(([type, fields]) => {
      result[type] = { ...fields };
    });
    return result;
  }

  /** Validate saved data field by field; anything wrong falls back to the default. */
  function normalizeSaved(raw) {
    const saved = isPlainObject(raw) ? raw : {};
    const type = Object.hasOwn(CONTENT_TYPES, saved.type) ? saved.type : 'text';
    const content = cloneDefaults();
    const savedContent = isPlainObject(saved.content) ? saved.content : {};
    Object.keys(content).forEach((name) => {
      if (isPlainObject(savedContent[name])) content[name] = normalizeFields(name, savedContent[name]);
    });
    return { type, content, style: normalizeStyle(saved.style), logoImage: validLogoImage(saved.logoImage) };
  }

  /** A saved center image is only accepted as a small PNG data URL (what section 07 produces). */
  function validLogoImage(value) {
    const valid =
      typeof value === 'string' && value.length <= MAX_SAVED_IMAGE_CHARS && SAVED_IMAGE_PATTERN.test(value);
    return valid ? value : '';
  }

  /** One type's fields: strings stay strings (length-limited), booleans stay booleans. */
  function normalizeFields(type, raw) {
    const fields = { ...DEFAULT_CONTENT[type] };
    Object.keys(fields).forEach((key) => {
      const value = raw[key];
      if (typeof fields[key] === 'boolean') fields[key] = value === true;
      else if (typeof value === 'string') fields[key] = value.slice(0, MAX_FIELD_LENGTH);
    });
    if (type === 'wifi' && !WIFI_SECURITY.includes(fields.security)) fields.security = 'WPA';
    return fields;
  }

  /** Style settings, each checked against its allowed values. */
  function normalizeStyle(raw) {
    const saved = isPlainObject(raw) ? raw : {};
    const margin = Number(saved.margin);
    return {
      ecc: ECC_LEVELS.includes(saved.ecc) ? saved.ecc : DEFAULT_STYLE.ecc,
      fg: HEX_COLOR.test(saved.fg) ? saved.fg.toLowerCase() : DEFAULT_STYLE.fg,
      bg: HEX_COLOR.test(saved.bg) ? saved.bg.toLowerCase() : DEFAULT_STYLE.bg,
      transparent: saved.transparent === true,
      shape: SHAPES.includes(saved.shape) ? saved.shape : DEFAULT_STYLE.shape,
      margin:
        Number.isInteger(margin) && margin >= MARGIN_RANGE.min && margin <= MARGIN_RANGE.max
          ? margin
          : DEFAULT_STYLE.margin,
      pngSize: PNG_SIZES.includes(Number(saved.pngSize)) ? Number(saved.pngSize) : DEFAULT_STYLE.pngSize,
      logo: LOGO_CHOICES.includes(saved.logo) ? saved.logo : DEFAULT_STYLE.logo,
    };
  }

  /** Saved state, or the defaults when nothing (valid) is saved. */
  function loadSaved() {
    const json = readStorage(STORAGE_KEYS.state);
    if (!json) return normalizeSaved(null);
    try {
      return normalizeSaved(JSON.parse(json));
    } catch (error) {
      console.warn('Tessera: saved data was damaged and has been ignored', error);
      return normalizeSaved(null);
    }
  }

  /** The state as JSON, without the fields that must never be stored (Wi-Fi password). */
  function serializeState() {
    const content = cloneDefaults();
    Object.keys(content).forEach((type) => {
      content[type] = normalizeFields(type, state.content[type]); // also caps very long text
      (UNSAVED_FIELDS[type] || []).forEach((key) => delete content[type][key]);
    });
    const saved = { version: 1, type: state.type, content, style: state.style, logoImage: state.logoImage };
    return JSON.stringify(saved);
  }

  /** Save shortly after the last change (typing doesn't write on every key). */
  function scheduleSave() {
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(saveNow, SAVE_DELAY_MS);
  }

  /** Save immediately. If the browser refuses (blocked or full storage), say so once. */
  function saveNow() {
    clearTimeout(state.saveTimer);
    state.saveTimer = 0;
    const saved = writeStorage(STORAGE_KEYS.state, serializeState());
    if (!saved && !state.saveWarned) {
      state.saveWarned = true;
      showToast("This browser won't let Tessera remember your work — it's kept until you close the tab");
    }
  }

  /** Leaving the page: write a pending save right away. */
  function flushPendingSave() {
    if (state.saveTimer) saveNow();
  }

  /** Something changed: redraw on the next frame and autosave. */
  function onChange() {
    scheduleRender();
    scheduleSave();
  }

  /* ==========================================================================
     06  FORM: CONTENT FIELDS
     Inputs carry data-type + data-key and map to state.content[type][key].
     ========================================================================== */
  /** Put the state's values into every content input. */
  function fillContentFields() {
    els.contentFields.forEach((input) => {
      const value = state.content[input.dataset.type][input.dataset.key];
      if (input.type === 'checkbox') input.checked = value;
      else input.value = value;
    });
    updateHttpsTip();
  }

  /** Show one type's fields and remember the choice. */
  function selectType(type) {
    state.type = type;
    const radio = els.typePicker.querySelector(`input[value="${type}"]`);
    if (radio) radio.checked = true;
    els.typePanels.forEach((panel) => {
      panel.hidden = panel.dataset.panel !== type;
    });
  }

  /** Type radio changed. */
  function handleTypeChange(event) {
    if (!event.target.matches('.type-input')) return;
    selectType(event.target.value);
    onChange();
  }

  /** A content field changed: copy its value into the state. */
  function handleContentInput(event) {
    const input = event.target;
    if (!input.dataset.type || !input.dataset.key) return;
    const fields = state.content[input.dataset.type];
    fields[input.dataset.key] = input.type === 'checkbox' ? input.checked : input.value;
    if (input === els.textInput) updateHttpsTip();
    onChange();
  }

  /** Show/hide the Wi-Fi password. */
  function togglePasswordVisibility() {
    const show = els.wifiPassword.type === 'password';
    els.wifiPassword.type = show ? 'text' : 'password';
    els.wifiShowBtn.setAttribute('aria-pressed', String(show));
    els.wifiShowBtn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    els.wifiShowBtn.replaceChildren(svgIcon(show ? 'eye-off' : 'eye'));
    scheduleRender(); // "what's inside the code" shows or hides the password too
  }

  /** "example.com/page" (no scheme, no spaces) looks like a link that phones won't open. */
  function looksLikeBareDomain(text) {
    return /^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d+)?([/?#]\S*)?$/i.test(text.trim());
  }

  /** Offer "add https://" for bare web addresses. */
  function updateHttpsTip() {
    els.httpsTip.hidden = !looksLikeBareDomain(state.content.text.text);
  }

  /** Put https:// in front of the text. */
  function addHttps() {
    const text = `https://${state.content.text.text.trim()}`;
    state.content.text.text = text;
    els.textInput.value = text;
    updateHttpsTip();
    els.textInput.focus();
    onChange();
  }

  /** "clear fields": empty the current type's fields (other types are kept). */
  function clearFields() {
    state.content[state.type] = { ...DEFAULT_CONTENT[state.type] };
    fillContentFields();
    const firstField = document.querySelector(`.type-panel[data-panel="${state.type}"] .field-input`);
    if (firstField) firstField.focus();
    onChange();
    showToast('Fields cleared');
  }

  /* ==========================================================================
     07  FORM: STYLE CONTROLS
     Inputs carry data-style="KEY" and map to state.style[KEY].
     ========================================================================== */
  /** Put the state's style into every style control. */
  function fillStyleControls() {
    els.styleFields.forEach((input) => {
      const value = state.style[input.dataset.style];
      if (input.type === 'checkbox') input.checked = value;
      else if (input.type === 'radio') input.checked = input.value === value;
      else input.value = String(value);
    });
    updateStyleLabels();
  }

  /** Read one style control as the right type of value. */
  function readStyleValue(input) {
    const key = input.dataset.style;
    if (input.type === 'checkbox') return input.checked;
    if (key === 'margin' || key === 'pngSize') return Number(input.value);
    if (key === 'fg' || key === 'bg') return input.value.toLowerCase();
    return input.value;
  }

  /** A style control changed. */
  function handleStyleInput(event) {
    const input = event.target;
    if (!input.dataset.style || (input.type === 'radio' && !input.checked)) return;
    state.style[input.dataset.style] = readStyleValue(input);
    updateStyleLabels();
    onChange();
  }

  /** Hex codes, margin value and contrast line next to the controls. */
  function updateStyleLabels() {
    const { fg, bg, margin, transparent } = state.style;
    els.fgHex.textContent = fg;
    els.bgHex.textContent = bg;
    els.marginValue.textContent = String(margin);
    const ratio = contrastRatio(fg, bg);
    const verdict = ratio >= GOOD_CONTRAST ? 'good' : 'too low';
    els.contrastText.textContent = transparent
      ? 'contrast depends on what the code is placed on'
      : `contrast ${ratio.toFixed(1)} : 1 — ${verdict}`;
    els.contrastText.classList.toggle('is-bad', !transparent && ratio < GOOD_CONTRAST);
    updateLogoControls();
  }

  /** Upload row, file name, and the note that a symbol raises error correction to H. */
  function updateLogoControls() {
    els.logoUpload.hidden = state.style.logo !== 'image';
    els.logoFileName.textContent = state.logoName || (state.logoImage ? 'saved image' : 'no image yet');
    const raised = hasLogo() && state.style.ecc !== LOGO_ECC;
    els.eccHint.textContent = raised
      ? `Using H while the center symbol is shown. Your choice (${state.style.ecc}) returns without it.`
      : ECC_HINT;
  }

  /** "choose image": open the file picker. */
  function chooseLogoFile() {
    els.logoFile.value = ''; // so picking the same file again still fires "change"
    els.logoFile.click();
  }

  /** A file was picked: check it, shrink it, and put it in the center. */
  async function handleLogoFile() {
    const file = els.logoFile.files[0];
    if (!file) return;
    if (!LOGO_FILE_TYPES.includes(file.type)) {
      showToast('Choose a PNG, JPG, WebP or GIF image');
      return;
    }
    if (file.size > MAX_LOGO_FILE_BYTES) {
      showToast('That image is too large (10 MB at most)');
      return;
    }
    try {
      await useLogoImage(await shrinkImage(file), file.name);
      showToast('Image added to the center');
    } catch (error) {
      console.error('Tessera: the image could not be used', error);
      showToast('That image could not be opened');
    }
  }

  /** Redraw the image at most LOGO_IMAGE_PX wide or high, as a PNG data URL (small enough to save). */
  async function shrinkImage(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await loadImage(url);
      const scale = Math.min(1, LOGO_IMAGE_PX / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas drawing is not available');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/png');
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /** Load an image and wait until it can be drawn. */
  async function loadImage(src) {
    const img = new Image();
    img.src = src;
    await img.decode();
    return img;
  }

  /** Make a prepared PNG data URL the center symbol. */
  async function useLogoImage(dataUrl, name) {
    state.logoImg = await loadImage(dataUrl);
    state.logoImage = dataUrl;
    state.logoName = name;
    state.style.logo = 'image';
    fillStyleControls();
    onChange();
  }

  /** At start-up: decode the saved center image, then redraw with it. */
  async function restoreLogoImage() {
    if (!state.logoImage) return;
    try {
      state.logoImg = await loadImage(state.logoImage);
      updateLogoControls();
      scheduleRender();
    } catch (error) {
      console.warn('Tessera: the saved center image was damaged and has been ignored', error);
      state.logoImage = '';
      updateLogoControls(); // "saved image" → "no image yet"
    }
  }

  /** Swap code and background colors. */
  function swapColors() {
    const { fg, bg } = state.style;
    state.style.fg = bg;
    state.style.bg = fg;
    fillStyleControls();
    onChange();
  }

  /** Back to the default style. */
  function resetStyle() {
    state.style = { ...DEFAULT_STYLE };
    fillStyleControls();
    onChange();
    showToast('Style reset');
  }

  /* ==========================================================================
     08  BUILDING THE CODE
     ========================================================================== */
  /** Redraw on the next animation frame (many quick edits → one redraw). */
  function scheduleRender() {
    cancelAnimationFrame(state.renderFrame);
    state.renderFrame = requestAnimationFrame(renderCode);
  }

  /** Build the code from the current fields and update the whole preview card. */
  function renderCode() {
    const result = buildCurrentCode();
    const hadCode = Boolean(state.code);
    state.code = result.code || null;
    if (state.code) showCode(state.code);
    else showPlaceholder(result.message, result.isError);
    els.payloadText.textContent = result.text ? payloadPreview(result.text) : '(nothing yet)';
    const styleWarnings = state.code ? collectStyleWarnings(state.code) : [];
    state.scanRisk = styleWarnings.length > 0;
    renderWarnings(state.code ? [...state.code.notes, ...styleWarnings] : []);
    setExportEnabled(Boolean(state.code));
    scheduleScanCheck();
    if (state.code && !hadCode && state.hasRendered) announce('QR code ready');
    state.hasRendered = true;
  }

  /**
   * Turn the current fields into a code.
   * @returns {{ code?: object, message?: string, isError?: boolean, text?: string }}
   */
  function buildCurrentCode() {
    const fields = state.content[state.type];
    const payload = CONTENT_TYPES[state.type].build(fields);
    if (payload.missing) return { message: payload.missing };
    try {
      const qr = QrEncoder.encode(payload.text, { ecc: effectiveEcc() });
      const code = { qr, text: payload.text, notes: payload.notes || [], type: state.type };
      code.logo = resolveLogo(state.type);
      return { code, text: payload.text };
    } catch (error) {
      if (error.code !== 'TOO_LONG') console.error('Tessera: could not make the code', error);
      const message =
        error.code === 'TOO_LONG' ? tooLongMessage(payload.text) : 'Something went wrong making this code';
      return { message, isError: true, text: payload.text };
    }
  }

  /**
   * Text for "what's inside the code": the Wi-Fi password is hidden while its
   * field is hidden, and very long text is shortened (it could be megabytes).
   */
  function payloadPreview(text) {
    let shown = text;
    const { password } = state.content.wifi;
    if (state.type === 'wifi' && password && els.wifiPassword.type === 'password') {
      shown = shown.replace(`P:${escapeWifi(password)};`, `P:${'•'.repeat(Math.min(password.length, 12))};`);
    }
    if (shown.length <= PAYLOAD_PREVIEW_CHARS) return shown;
    const hidden = formatNumber(shown.length - PAYLOAD_PREVIEW_CHARS);
    return `${shown.slice(0, PAYLOAD_PREVIEW_CHARS)}… (${hidden} more characters)`;
  }

  /** Explain how far over the limit the text is, and what to do. */
  function tooLongMessage(text) {
    const ecc = effectiveEcc();
    const { mode, used, max } = QrEncoder.capacity(text, ecc);
    const unit = CAPACITY_UNITS[mode];
    let advice = ecc === 'L' ? 'shorten it' : 'shorten it or choose a lower error-correction level';
    if (hasLogo()) advice = 'shorten it or remove the center symbol';
    return `Too long for a QR code: ${formatNumber(used)} ${unit}. Level ${ecc} holds up to ${formatNumber(max)} ${unit} — ${advice}.`;
  }

  /** True when a center symbol will actually be drawn (an own image needs a loaded file). */
  function hasLogo() {
    const choice = state.style.logo;
    return choice !== 'none' && (choice !== 'image' || Boolean(state.logoImg));
  }

  /** A center symbol needs level H; otherwise the user's choice applies. */
  function effectiveEcc() {
    return hasLogo() ? LOGO_ECC : state.style.ecc;
  }

  /** What goes in the middle: { icon: pathData }, { image, src }, or null for nothing. */
  function resolveLogo(type) {
    if (!hasLogo()) return null;
    const choice = state.style.logo;
    if (choice === 'image') return { image: state.logoImg, src: state.logoImage };
    return { icon: LOGO_ICONS[choice === 'auto' ? TYPE_LOGOS[type] : choice] };
  }

  /** Put the code in the preview frame and fill in the details line. */
  function showCode(code) {
    const svg = createQrSvg(code, state.style);
    svg.classList.add('qr-svg');
    svg.setAttribute('role', 'img');
    const symbol = code.logo ? ' with a center symbol' : '';
    svg.setAttribute('aria-label', `QR code: ${CONTENT_TYPES[code.type].label}${symbol}`);
    const old = els.qrFrame.querySelector('.qr-svg');
    if (old) old.replaceWith(svg);
    else els.qrFrame.prepend(svg);
    els.qrFrame.className = `qr-frame${state.style.transparent ? ' is-transparent' : ''}`;
    els.qrMessage.hidden = true;
    els.qrInfo.textContent = codeInfo(code);
    els.qrInfo.hidden = false;
  }

  /** "version 3 · 29×29 modules · level M · 42 bytes · png 1036 px" */
  function codeInfo({ qr, text }) {
    const pngPx = pngPixelSize(qr);
    const parts = [`version ${qr.version}`, `${qr.size}×${qr.size} modules`, `level ${qr.ecc}`];
    parts.push(`${formatNumber(byteLength(text))} bytes`, `png ${formatNumber(pngPx)} px`);
    return parts.join(' · ');
  }

  /** No code: show the message in the frame instead. */
  function showPlaceholder(message, isError) {
    const old = els.qrFrame.querySelector('.qr-svg');
    if (old) old.remove();
    els.qrFrame.className = `qr-frame is-empty${isError ? ' is-error' : ''}`;
    if (els.qrMessage.textContent !== message) els.qrMessage.textContent = message;
    els.qrMessage.hidden = false;
    els.qrInfo.hidden = true;
  }

  /* ==========================================================================
     09  DRAWING
     One SVG path (in module units) describes the code. It is used for the
     preview <svg>, the downloaded .svg, and — via Path2D — the PNG canvas,
     so all three always look the same.
     ========================================================================== */
  /** Round to 3 decimals for compact path data. */
  function num(value) {
    return String(Math.round(value * 1000) / 1000);
  }

  /** Path data for the whole code (fill it with fill-rule "evenodd"). Modules under a symbol are left out. */
  function buildPathData(qr, style, logo) {
    const isCleared = clearedTest(qr, logo);
    if (style.shape === 'square') return squarePath(qr, style.margin, isCleared);
    return eyesPath(qr.size, style.margin) + shapedModulesPath(qr, style.margin, style.shape, isCleared);
  }

  /**
   * The square kept free for the symbol, in modules (margin not included).
   * Its side is odd when the code's is, so it sits exactly in the middle.
   */
  function logoArea(qr) {
    let side = Math.min(Math.round(qr.size * LOGO_AREA), LOGO_MAX_SIDE);
    if (side % 2 !== qr.size % 2) side += 1;
    const start = (qr.size - side) / 2;
    return { start, end: start + side, side };
  }

  /** (x, y) → true when that module lies under the symbol and must not be drawn. */
  function clearedTest(qr, logo) {
    if (!logo) return () => false;
    const { start, end } = logoArea(qr);
    return (x, y) => x >= start && x < end && y >= start && y < end;
  }

  /** Square modules: each horizontal run of dark modules becomes one rectangle. */
  function squarePath({ size, modules }, offset, isCleared) {
    const isDark = (x, y) => modules[y][x] && !isCleared(x, y);
    let path = '';
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!isDark(x, y)) continue;
        const start = x;
        while (x + 1 < size && isDark(x + 1, y)) x++;
        path += `M${start + offset} ${y + offset}h${x - start + 1}v1h${start - x - 1}z`;
      }
    }
    return path;
  }

  /** Dots or rounded squares for every dark module outside the three eyes and the symbol area. */
  function shapedModulesPath({ size, modules }, offset, shape, isCleared) {
    let path = '';
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!modules[y][x] || isCleared(x, y) || QrEncoder.isFinderModule(size, x, y)) continue;
        path +=
          shape === 'dots'
            ? circlePath(x + offset + 0.5, y + offset + 0.5, DOT_RADIUS)
            : roundedRectPath(x + offset, y + offset, 1, ROUNDED_RADIUS);
      }
    }
    return path;
  }

  /** The three finder "eyes" with rounded corners: ring + centre (evenodd cuts the hole). */
  function eyesPath(size, offset) {
    const corners = [
      [0, 0],
      [size - 7, 0],
      [0, size - 7],
    ];
    return corners
      .map(([x, y]) => {
        const left = x + offset;
        const top = y + offset;
        return (
          roundedRectPath(left, top, 7, EYE_RADII[0]) +
          roundedRectPath(left + 1, top + 1, 5, EYE_RADII[1]) +
          roundedRectPath(left + 2, top + 2, 3, EYE_RADII[2])
        );
      })
      .join('');
  }

  /** Square of side `side` at (x, y) with corner radius r. */
  function roundedRectPath(x, y, side, r) {
    const edge = num(side - 2 * r);
    const arc = (dx, dy) => `a${num(r)} ${num(r)} 0 0 1 ${num(dx)} ${num(dy)}`;
    return `M${num(x + r)} ${num(y)}h${edge}${arc(r, r)}v${edge}${arc(-r, r)}h-${edge}${arc(-r, -r)}v-${edge}${arc(r, -r)}z`;
  }

  /** Circle as two half-arcs (SVG paths have no circle command). */
  function circlePath(cx, cy, r) {
    const d = num(2 * r);
    return `M${num(cx - r)} ${num(cy)}a${num(r)} ${num(r)} 0 1 0 ${d} 0a${num(r)} ${num(r)} 0 1 0 -${d} 0z`;
  }

  /** Width/height of the code in modules, margin included. */
  function totalModules(qr, style) {
    return qr.size + 2 * style.margin;
  }

  /** Whole pixels per module for the chosen PNG size (keeps edges sharp). */
  function modulePixels(qr, style = state.style) {
    return Math.max(1, Math.round(style.pngSize / totalModules(qr, style)));
  }

  /** Final PNG width/height in pixels. */
  function pngPixelSize(qr) {
    return modulePixels(qr) * totalModules(qr, state.style);
  }

  /** The code as an <svg> element (used for the preview and the .svg download). */
  function createQrSvg(code, style) {
    const total = totalModules(code.qr, style);
    const pixels = modulePixels(code.qr, style) * total;
    const svg = svgEl('svg', { viewBox: `0 0 ${total} ${total}`, width: pixels, height: pixels });
    if (!style.transparent) svg.append(svgEl('rect', { width: total, height: total, fill: style.bg }));
    const pathData = buildPathData(code.qr, style, code.logo);
    const path = svgEl('path', { d: pathData, fill: style.fg, 'fill-rule': 'evenodd' });
    if (style.shape === 'square') path.setAttribute('shape-rendering', 'crispEdges');
    svg.append(path);
    if (code.logo) svg.append(svgLogo(code.logo, logoBox(code.qr, style), style));
    return svg;
  }

  /** Where the symbol is drawn: the cleared square minus padding, in module units, margin included. */
  function logoBox(qr, style) {
    const { start, side } = logoArea(qr);
    const padding = side * LOGO_PADDING;
    return { x: start + style.margin + padding, y: start + style.margin + padding, size: side - 2 * padding };
  }

  /** Fit a width×height picture inside the square box, keeping its proportions, centred. */
  function fitInBox(box, width, height) {
    const scale = box.size / Math.max(width, height);
    const w = width * scale;
    const h = height * scale;
    return { x: box.x + (box.size - w) / 2, y: box.y + (box.size - h) / 2, w, h };
  }

  /** The symbol as SVG: the embedded image, or a line icon in the code color. */
  function svgLogo(logo, box, style) {
    if (logo.image) {
      const fit = fitInBox(box, logo.image.naturalWidth, logo.image.naturalHeight);
      const size = { x: num(fit.x), y: num(fit.y), width: num(fit.w), height: num(fit.h) };
      const image = svgEl('image', { ...size, href: logo.src });
      image.setAttributeNS(XLINK_NS, 'xlink:href', logo.src); // older design tools only read xlink:href
      return image;
    }
    const transform = `translate(${num(box.x)} ${num(box.y)}) scale(${num(box.size / 24)})`;
    const group = svgEl('g', { transform, fill: 'none', stroke: style.fg, 'stroke-width': LOGO_STROKE });
    group.setAttribute('stroke-linecap', 'round');
    group.setAttribute('stroke-linejoin', 'round');
    group.append(svgEl('path', { d: logo.icon }));
    return group;
  }

  /** The symbol on a canvas whose units are already modules (see drawCanvas). */
  function drawCanvasLogo(ctx, logo, box, style) {
    if (logo.image) {
      const fit = fitInBox(box, logo.image.naturalWidth, logo.image.naturalHeight);
      ctx.drawImage(logo.image, fit.x, fit.y, fit.w, fit.h);
      return;
    }
    ctx.save();
    ctx.translate(box.x, box.y);
    ctx.scale(box.size / 24, box.size / 24);
    ctx.strokeStyle = style.fg;
    ctx.lineWidth = LOGO_STROKE;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(new Path2D(logo.icon));
    ctx.restore();
  }

  /**
   * Draw the code on a canvas.
   * @param {string} [backdrop] color painted under a transparent code (used by the scan check)
   */
  function drawCanvas(code, style, pixelsPerModule, backdrop) {
    const total = totalModules(code.qr, style);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = total * pixelsPerModule;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas drawing is not available');
    const background = style.transparent ? backdrop : style.bg;
    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.scale(pixelsPerModule, pixelsPerModule);
    ctx.fillStyle = style.fg;
    ctx.fill(new Path2D(buildPathData(code.qr, style, code.logo)), 'evenodd');
    if (code.logo) drawCanvasLogo(ctx, code.logo, logoBox(code.qr, style), style);
    return canvas;
  }

  /* ==========================================================================
     10  WARNINGS & CONTRAST
     ========================================================================== */
  /** "#rrggbb" → relative luminance (WCAG formula, 0 = black, 1 = white). */
  function luminance(hex) {
    const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const linear = channels.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  }

  /** WCAG contrast ratio between two colors (1 to 21). */
  function contrastRatio(a, b) {
    const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (light + 0.05) / (dark + 0.05);
  }

  /**
   * Everything about the look of this code that might stop it scanning reliably.
   * (Content notes, like a missing country code, come from the type's build function.)
   */
  function collectStyleWarnings(code) {
    return [...colorWarnings(), ...layoutWarnings(code)];
  }

  /** Contrast, inverted colors and transparency. */
  function colorWarnings() {
    const { fg, bg, transparent } = state.style;
    if (transparent) return ['Transparent background — place it on a plain, light background.'];
    const warnings = [];
    const ratio = contrastRatio(fg, bg);
    if (ratio < GOOD_CONTRAST) {
      warnings.push(
        `Low contrast (${ratio.toFixed(1)} : 1) — many scanners will fail. Aim for 4 : 1 or more.`,
      );
    }
    if (luminance(fg) > luminance(bg)) {
      warnings.push("Light code on a dark background — some scanner apps can't read inverted codes.");
    }
    return warnings;
  }

  /** Margin, density, and dots combined with a center symbol. */
  function layoutWarnings(code) {
    const { margin, shape } = state.style;
    const { version } = code.qr;
    const warnings = [];
    if (margin < MARGIN_RANGE.recommended) {
      warnings.push(`Margin under ${MARGIN_RANGE.recommended} — only reliable on a plain, light background.`);
    }
    const symbolWarning = code.logo && symbolRisk(shape, version);
    if (symbolWarning) warnings.push(symbolWarning);
    if (version >= DENSE_VERSION) {
      warnings.push(`Dense code (version ${version}) — print it large, or use shorter text.`);
    }
    return warnings;
  }

  /** Warning for a center symbol on a code too dense for it (limits found by testing), or ''. */
  function symbolRisk(shape, version) {
    if (version > SYMBOL_MAX_VERSION) {
      return 'A center symbol on a code this dense may not scan — shorten the text or remove the symbol.';
    }
    if (shape === 'dots' && version > DOTS_WITH_SYMBOL_MAX_VERSION) {
      return 'Dots with a center symbol often fail on a code this dense — use rounded or square modules.';
    }
    return '';
  }

  /** Show the warning list (hidden when empty). */
  function renderWarnings(warnings) {
    const items = warnings.map((text) => {
      const item = el('li', 'warning');
      item.append(svgIcon('alert', 'icon--status icon--warn'), el('span', '', text));
      return item;
    });
    els.warningList.replaceChildren(...items);
    els.warningList.hidden = items.length === 0;
  }

  /* ==========================================================================
     11  SCAN CHECK
     Browsers with the Barcode Detection API (Chrome on Android, macOS and
     ChromeOS) read each finished code back. Others simply skip this.
     ========================================================================== */
  const scannerReady = createScanner();

  /** A QR BarcodeDetector, or null when the browser has none. */
  async function createScanner() {
    if (!('BarcodeDetector' in window)) return null;
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      return formats.includes('qr_code') ? new window.BarcodeDetector({ formats: ['qr_code'] }) : null;
    } catch (error) {
      console.warn('Tessera: barcode reader not available', error);
      return null;
    }
  }

  /** Run the check once typing pauses. */
  function scheduleScanCheck() {
    clearTimeout(state.scanTimer);
    state.scanRun++; // any check still running is now out of date
    if (!state.code) {
      els.scanStatus.hidden = true;
      return;
    }
    els.scanStatus.dataset.state = 'checking';
    state.scanTimer = setTimeout(runScanCheck, SCAN_DELAY_MS);
  }

  /** Draw the code as an image, read it back, and compare with what should be inside. */
  async function runScanCheck() {
    const run = state.scanRun;
    const code = state.code;
    const scanner = await scannerReady;
    if (!scanner || !code) return;
    try {
      const canvas = drawCanvas(code, state.style, SCAN_MODULE_PX, '#ffffff');
      const results = await scanner.detect(canvas);
      if (run !== state.scanRun) return; // the code changed meanwhile
      showScanResult(results.some((result) => result.rawValue === code.text));
    } catch (error) {
      console.warn('Tessera: scan check could not run', error);
      if (run === state.scanRun) els.scanStatus.hidden = true;
    }
  }

  /** ✓ or ✗ line under the code. */
  function showScanResult(passed) {
    els.scanStatus.dataset.state = passed ? 'ok' : 'fail';
    els.scanStatus.replaceChildren(
      svgIcon(passed ? 'check' : 'alert', 'icon--status'),
      el('span', '', scanMessage(passed)),
    );
    els.scanStatus.hidden = false;
  }

  /**
   * Text for the scan line. This browser's reader is more forgiving than many
   * phone cameras, so a pass still points at any warnings.
   */
  function scanMessage(passed) {
    if (!passed) return 'scan check failed — try more contrast, a bigger margin or square modules';
    return !state.scanRisk
      ? 'scan check passed — this browser read it back correctly'
      : 'this browser read it back, but older phone cameras may not — see the warnings';
  }

  /* ==========================================================================
     12  EXPORT (PNG, SVG, COPY)
     ========================================================================== */
  /** Enable/disable the export buttons (aria-disabled keeps them focusable). */
  function setExportEnabled(enabled) {
    [els.pngBtn, els.svgBtn, els.copyBtn].forEach((button) => {
      button.setAttribute('aria-disabled', String(!enabled));
    });
  }

  /** True when there is a code to export; otherwise explain why not. */
  function ensureCode() {
    if (state.code) return true;
    showToast('Nothing to export yet — fill in the fields first');
    return false;
  }

  /** "qr-wifi-home-network.png" */
  function exportFileName(extension) {
    const fields = state.content[state.code.type];
    const slug = slugify(CONTENT_TYPES[state.code.type].fileName(fields));
    return `qr-${state.code.type}${slug ? `-${slug}` : ''}.${extension}`;
  }

  /** canvas.toBlob as a promise. */
  function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Could not create the image'))),
        'image/png',
      );
    });
  }

  /** Save a Blob as a file. Returns false (and tells the user) on failure. */
  function downloadBlob(blob, fileName) {
    try {
      const url = URL.createObjectURL(blob);
      const link = el('a');
      link.href = url;
      link.download = fileName;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return true;
    } catch (error) {
      console.error('Tessera: download failed', error);
      showToast('The download could not start');
      return false;
    }
  }

  /** Download the PNG at the chosen size. */
  async function downloadPng() {
    if (!ensureCode()) return;
    try {
      const canvas = drawCanvas(state.code, state.style, modulePixels(state.code.qr));
      const blob = await canvasToBlob(canvas);
      if (downloadBlob(blob, exportFileName('png'))) {
        showToast(`PNG downloaded (${canvas.width} × ${canvas.height} px)`);
      }
    } catch (error) {
      console.error('Tessera: PNG export failed', error);
      showToast('The PNG could not be created');
    }
  }

  /** Download the SVG (a vector file, sharp at any size). */
  function downloadSvg() {
    if (!ensureCode()) return;
    const svg = createQrSvg(state.code, state.style);
    const markup = `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(svg)}\n`;
    const blob = new Blob([markup], { type: 'image/svg+xml' });
    if (downloadBlob(blob, exportFileName('svg'))) showToast('SVG downloaded');
  }

  /** True when this browser can put images on the clipboard. */
  function canCopyImages() {
    return Boolean(navigator.clipboard && navigator.clipboard.write && window.ClipboardItem);
  }

  /** Copy the PNG to the clipboard. */
  async function copyPng() {
    if (!ensureCode()) return;
    try {
      const canvas = drawCanvas(state.code, state.style, modulePixels(state.code.qr));
      // Passing the promise (not the blob) keeps Safari's "user gesture" requirement happy.
      await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': canvasToBlob(canvas) })]);
      showToast('Image copied — paste it anywhere');
    } catch (error) {
      console.error('Tessera: copy failed', error);
      showToast('Copy was blocked by the browser — use png instead');
    }
  }

  /* ==========================================================================
     13  DIALOGS
     Native <dialog>.showModal() gives Esc-to-close and a focus trap.
     Added here: backdrop click, [data-close] buttons, focus restore.
     ========================================================================== */
  const returnFocus = new WeakMap();

  /** Open a dialog as modal and remember where focus should return. */
  function openDialog(dialog) {
    if (dialog.open) return;
    returnFocus.set(dialog, document.activeElement);
    dialog.showModal();
    const body = dialog.querySelector('.dialog-body');
    if (body) body.scrollTop = 0;
  }

  /** Shared behaviour for every dialog: close buttons, backdrop click, focus restore. */
  function bindDialog(dialog) {
    dialog.addEventListener('click', (event) => {
      // The dialog has no padding, so a click on the dialog itself is a backdrop click.
      if (event.target === dialog || event.target.closest('[data-close]')) dialog.close();
    });
    dialog.addEventListener('close', () => {
      const previous = returnFocus.get(dialog);
      if (previous && document.contains(previous) && typeof previous.focus === 'function') previous.focus();
      returnFocus.delete(dialog);
    });
  }

  /** Open the help guide. */
  function openHelp() {
    openDialog(els.helpDialog);
  }

  /* ==========================================================================
     14  TOAST & SCREEN-READER ANNOUNCEMENTS
     ========================================================================== */
  // With the Popover API the toast sits in the top layer, above open dialogs.
  const supportsPopover = typeof HTMLElement.prototype.showPopover === 'function';
  let toastTimer = 0;

  /** Show a short message at the bottom of the screen (and announce it). */
  function showToast(message) {
    els.toast.textContent = message;
    setToastVisible(false); // re-open so it restarts the animation and stacks on top
    setToastVisible(true);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => setToastVisible(false), TOAST_MS);
    announce(message);
  }

  /** Show/hide the toast — via the Popover API when supported, else the hidden attribute. */
  function setToastVisible(visible) {
    const toast = els.toast;
    if (!supportsPopover) {
      toast.hidden = !visible;
      return;
    }
    const isOpen = toast.matches(':popover-open');
    if (visible && !isOpen) toast.showPopover();
    if (!visible && isOpen) toast.hidePopover();
  }

  /**
   * Read a message to screen-reader users. While a modal dialog is open,
   * content outside it is hidden from assistive tech, so the message goes to
   * that dialog's own status line.
   */
  function announce(message) {
    const openDialogEl = document.querySelector('dialog[open]');
    const region = (openDialogEl && openDialogEl.querySelector('.dialog-status')) || els.announcer;
    region.textContent = '';
    // A short delay makes repeated identical messages announce again.
    setTimeout(() => {
      region.textContent = message;
    }, 50);
  }

  /* ==========================================================================
     15  THEME (app interface only — the code keeps its own colors)
     ========================================================================== */
  /** Saved theme, or "auto" when missing/unknown. */
  function readTheme() {
    const saved = readStorage(STORAGE_KEYS.theme);
    return THEMES.includes(saved) ? saved : 'auto';
  }

  /** Apply a theme to the page, browser bar and theme button. */
  function applyTheme(theme) {
    state.theme = theme;
    if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);

    document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => {
      if (!meta.dataset.default) meta.dataset.default = meta.content;
      meta.content = THEME_BAR_COLORS[theme] || meta.dataset.default;
    });
    const next = nextTheme(theme);
    els.themeBtn.replaceChildren(svgIcon(`theme-${theme}`));
    els.themeBtn.setAttribute('aria-label', `Theme: ${theme}. Switch to ${next}`);
    els.themeBtn.title = `Theme: ${theme} (click for ${next})`;
  }

  /** auto → light → dark → auto */
  function nextTheme(theme) {
    return THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  }

  /** Theme button: switch to the next theme and remember it. */
  function cycleTheme() {
    const theme = nextTheme(state.theme);
    applyTheme(theme);
    writeStorage(STORAGE_KEYS.theme, theme);
    showToast(`Theme: ${theme}`);
  }

  /* ==========================================================================
     16  KEYBOARD SHORTCUTS
     Keep this list in sync with the help guide (index.html) and README.
     ========================================================================== */
  /** True when the user is typing in a field (single-key shortcuts must not fire). */
  function isTypingTarget(target) {
    return target.matches('input:not([type="checkbox"], [type="radio"], [type="range"]), textarea, select');
  }

  /** Global keydown: ? = help, Ctrl/⌘ S = download PNG. */
  function handleShortcuts(event) {
    if (document.querySelector('dialog[open]') || event.altKey) return;
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && !event.shiftKey && event.key.toLowerCase() === 's') {
      event.preventDefault();
      downloadPng();
      return;
    }
    if (!modifier && event.key === '?' && !isTypingTarget(event.target)) {
      event.preventDefault();
      openHelp();
    }
  }

  /* ==========================================================================
     17  INIT
     ========================================================================== */
  /** Wire every listener, grouped by area of the page. */
  function bindEvents() {
    els.helpBtn.addEventListener('click', openHelp);
    els.themeBtn.addEventListener('click', cycleTheme);
    bindContentCard();
    bindPreviewCard();
    bindStyleCard();
    bindDialog(els.helpDialog);
    document.addEventListener('keydown', handleShortcuts);
    window.addEventListener('pagehide', flushPendingSave);
    window.addEventListener('storage', handleStorageChange);
  }

  /**
   * Another tab changed Tessera's saved data. The theme simply follows; for
   * the content, warn once that the last tab to change something wins.
   */
  function handleStorageChange(event) {
    if (event.key === STORAGE_KEYS.theme) applyTheme(readTheme());
    if (event.key !== STORAGE_KEYS.state || state.otherTabWarned) return;
    state.otherTabWarned = true;
    showToast('Tessera is open in another tab — the tab you change last is the one remembered');
  }

  /** Type picker, fields and their helper buttons. */
  function bindContentCard() {
    els.typePicker.addEventListener('change', handleTypeChange);
    els.contentFields.forEach((input) => {
      input.addEventListener('input', handleContentInput);
      input.addEventListener('change', handleContentInput); // older Safari: checkboxes fire only "change"
    });
    els.wifiShowBtn.addEventListener('click', togglePasswordVisibility);
    els.httpsBtn.addEventListener('click', addHttps);
    els.clearBtn.addEventListener('click', clearFields);
  }

  /** Export buttons. */
  function bindPreviewCard() {
    els.pngBtn.addEventListener('click', downloadPng);
    els.svgBtn.addEventListener('click', downloadSvg);
    els.copyBtn.addEventListener('click', copyPng);
  }

  /** Style controls (delegated) and their buttons. */
  function bindStyleCard() {
    els.styleCard.addEventListener('input', handleStyleInput);
    els.styleCard.addEventListener('change', handleStyleInput);
    els.swapBtn.addEventListener('click', swapColors);
    els.logoChooseBtn.addEventListener('click', chooseLogoFile);
    els.logoFile.addEventListener('change', handleLogoFile);
    els.resetStyleBtn.addEventListener('click', resetStyle);
  }

  /** Start the app: restore the theme and the last session, then draw the code. */
  function init() {
    applyTheme(readTheme());
    if (!QrEncoder) {
      showPlaceholder('The QR encoder (assets/js/qrcode.js) did not load. Check that the file exists.', true);
      return;
    }
    if (supportsPopover) {
      els.toast.setAttribute('popover', 'manual');
      els.toast.hidden = false; // the popover state controls visibility from now on
    }
    if (!canCopyImages()) els.copyBtn.hidden = true;

    const saved = loadSaved();
    state.content = saved.content;
    state.style = saved.style;
    state.logoImage = saved.logoImage; // set now so an early autosave can't drop it
    selectType(saved.type);
    fillContentFields();
    fillStyleControls();
    renderCode();
    bindEvents();
    restoreLogoImage();
  }

  init();
})();
