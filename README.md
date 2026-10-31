# Tessera — QR Code Generator

Make QR codes for links, Wi-Fi, contacts, email, phone calls and text messages. Style them, check that they scan, and download a PNG or SVG. Everything runs in the browser, and nothing is uploaded.

Open `index.html` in a modern browser (Chrome, Edge, Safari or Firefox). There's no build step, no server and no third-party script: the QR encoder is written from scratch in `qrcode.js`.

---

## Project structure

```
QR_Generator/
├── index.html           Page structure, form, help text, icon sprite
├── README.md            This file
├── package.json         Lint/format scripts (Node is NOT needed to run the app)
├── eslint.config.mjs    JavaScript rules
├── .stylelintrc.json    CSS rules (stylelint-config-standard, BEM class names allowed)
├── .htmlvalidate.json   HTML rules (html-validate recommended, Prettier-compatible)
├── .prettierrc.json     Formatting (Prettier, single quotes, 110 columns)
└── assets/
    ├── css/style.css    All styling (mobile-first, light/dark themes)
    └── js/
        ├── qrcode.js    QR encoder (ISO/IEC 18004): text → grid of modules
        └── app.js       App behaviour: form, preview, warnings, scan check, export
```

Each file starts with a **table of contents**. Section numbers in comments (for example `section 09`) refer to those tables. `qrcode.js` must load before `app.js`.

---

## Features

- **Six content types.** Each one uses the format phone cameras understand:

  | Type        | Stored as                   | When scanned                      |
  | ----------- | --------------------------- | --------------------------------- |
  | link / text | the text itself             | opens the link, or shows the text |
  | wi-fi       | `WIFI:T:WPA;S:…;P:…;;`      | offers to join the network        |
  | contact     | vCard 3.0                   | offers to save the contact        |
  | email       | `mailto:…?subject=…&body=…` | opens a new email                 |
  | phone       | `tel:+…`                    | offers to call                    |
  | sms         | `SMSTO:+…:message`          | opens a text message              |

  Special characters are escaped for each format. Switching types keeps what you typed in the others.

- **Live preview** with details: version, size in modules, error-correction level, bytes and the exact PNG size. **What's inside the code** shows the exact text.
- **Style.**
  - error correction: L, M, Q or H
  - code and background colors, with a swap button and a live contrast ratio
  - transparent background
  - square, rounded or dot modules (the three corner "eyes" stay solid so they're easy to find)
  - margin (quiet zone) from 0 to 8 modules
  - PNG size from about 256 to 2048 px
  - a **center symbol**: one that matches the type, one of 8 built-in symbols (Wi-Fi, link, phone, email, person, message, heart, star), or your own image (PNG, JPG, WebP or GIF, shrunk to 256 px and remembered)

  With a symbol, the modules underneath are left out rather than covered, and error correction goes up to **H** so the code still scans. The cleared square is 22% of the code's width, up to 17 modules. In tests with Chrome's reader, every built-in symbol and an uploaded image scanned with square and rounded modules up to version 24 (roughly 470 characters of text). Some symbols failed from version 27, and dots with a symbol failed from version 17, so the app warns in both cases.

- **Warnings** for anything that can stop a code from scanning: low contrast, light-on-dark colors, a transparent background, a small margin, very dense codes, a Wi-Fi network without a password, and phone numbers without a country code.
- **Scan check.** In browsers with a built-in barcode reader (Chrome on macOS, Android and ChromeOS), every code is drawn as an image and read back. Other browsers skip the check.
- **Export.**
  - **PNG**, rounded so every module is a whole number of pixels, which keeps the edges sharp
  - **SVG**, sharp at any size
  - **copy** the PNG to the clipboard, where the browser allows it

  File names describe the content, for example `qr-wifi-cafe-guest.png`.

- **Remembers** your last content and style in `localStorage`. The **Wi-Fi password is never saved**, and it's hidden in "what's inside the code" until you press the eye button.
- **Themes.** Light, dark and auto, for the app only. The code always uses the colors you choose.

### Why write the encoder instead of using a library?

It keeps the app fully offline with no third-party code, and it's small (one file, about 600 lines). Its output was tested against the `qrcode` npm package: identical modules for all 40 versions and all 4 levels in numeric, alphanumeric and byte modes. Every sample also decoded correctly with the jsQR reader.

---

## Keyboard shortcuts

| Key        | Action                                         |
| ---------- | ---------------------------------------------- |
| `Ctrl/⌘ S` | Download the PNG                               |
| `?`        | Help guide (when not typing)                   |
| `Esc`      | Close the help guide                           |
| `←` `→`    | Move between types, shapes (the radio buttons) |

---

## Common changes

### Add a field to an existing type (e.g. "address" for contacts)

1. In **`index.html`**, copy an input in that type's `.type-panel` and give it `data-type="contact" data-key="address"`.
2. In **`app.js` → section 02**, add `address: ''` to that type in `DEFAULT_CONTENT`, then use `fields.address` in its `build…Payload` function.

Saving, loading and clearing pick it up automatically.

### Add a new type (e.g. "location")

1. **`index.html`**: add a radio to `.type-picker` (`value="geo"`) and a `<div class="type-panel" data-panel="geo" hidden>` with its inputs.
2. **`app.js` → section 02**: add default fields to `DEFAULT_CONTENT`, an entry to `CONTENT_TYPES`, and a `buildGeoPayload(fields)` that returns `{ text }` or `{ missing: 'message' }`.

### Keep a field out of saved data

Add its key to `UNSAVED_FIELDS` in **`app.js` → section 02** (like the Wi-Fi password).

### Change the warning thresholds

`GOOD_CONTRAST`, `DENSE_VERSION` and `MARGIN_RANGE` are in **`app.js` → section 01**.

### Add a built-in center symbol

1. In **`app.js` → section 01**, add a line drawing on a 24×24 grid to `LOGO_ICONS` (stroke paths, like the sprite icons) and its key to `LOGO_CHOICES`.
2. In **`index.html`**, add an `<option>` with the same value to the Center symbol select.

`LOGO_AREA` and `LOGO_MAX_SIDE` (how much of the code is kept free), `LOGO_ECC`, and the tested limits `SYMBOL_MAX_VERSION` and `DOTS_WITH_SYMBOL_MAX_VERSION` are also in section 01. Check the scan line after changing them.

### Change dot or corner shapes

`DOT_RADIUS`, `ROUNDED_RADIUS` and `EYE_RADII` are in **`app.js` → section 01**. The geometry is in section 09. One SVG path drives the preview, the SVG file and the PNG, so they always match.

### Edit the help guide

Edit the help guide as plain HTML in **`index.html`**, inside `<dialog id="helpDialog">`.

### Change app colors

Edit the design tokens in **`style.css` → section 01**. The dark theme appears twice: once for the manual setting and once for `auto`. Keep both blocks identical.

---

## Code checks

Node.js is **only** needed for these checks. The app itself runs from `index.html` without it.

```sh
npm install          # once: downloads the checkers into node_modules/
npm run lint         # HTML + CSS + JS + formatting; must pass before shipping
npm run format       # auto-format every file with Prettier
```

| Tool          | Checks                                               | Config               |
| ------------- | ---------------------------------------------------- | -------------------- |
| html-validate | Valid HTML, accessible names, ARIA usage, WCAG rules | `.htmlvalidate.json` |
| Stylelint     | Modern, error-free CSS                               | `.stylelintrc.json`  |
| ESLint        | JavaScript bugs and unsafe patterns                  | `eslint.config.mjs`  |
| Prettier      | Consistent formatting                                | `.prettierrc.json`   |

---

## Standards followed

- **QR Code (ISO/IEC 18004).**
  - versions 1–40 and levels L/M/Q/H
  - numeric, alphanumeric and UTF-8 byte modes
  - Reed–Solomon error correction
  - all 8 masks scored with the standard's 4 penalty rules
- **Accessibility (WCAG 2.1 AA).**
  - All text has a contrast ratio of at least 4.5:1, in both themes.
  - Every input has a label, and the type and shape pickers are real radio buttons (arrow keys work).
  - There is a skip link and visible focus rings.
  - The code has an accessible name.
  - Disabled export buttons use `aria-disabled`, so they stay focusable and explain why.
  - Status messages are announced, and reduced motion is respected.
- **Security.**
  - All user text is inserted with `textContent` and never parsed as HTML.
  - The SVG is built with DOM methods.
  - Saved data is validated field by field (`normalizeSaved()`), so damaged or edited data falls back to the defaults.
- **Privacy.** No uploads, analytics or third-party scripts. The only outside request is for Google Fonts. The Wi-Fi password stays in memory only.
- **Responsive and mobile-first.**
  - Phones get one column in reading order: content, preview, style.
  - From 600px, fields go two per row.
  - From 900px, the preview stays in view on the right.
- **Robustness.**
  - Storage, download, copy and drawing failures are shown to the user and logged with a `Tessera:` prefix.
  - If `qrcode.js` fails to load, the page says so.
  - Text longer than any QR code can hold (7,089 characters) is refused instantly, even a multi-megabyte paste.
  - The "too long" message gives the real limit for the kind of text (digits, capitals or bytes).
  - A second open tab gets a one-time notice, and the theme follows it.
- **Code style.**
  - The code uses `'use strict'`, and every function has a JSDoc comment and is no longer than 25 lines.
  - Each file has a table of contents.
  - ESLint, Stylelint, html-validate and Prettier all pass.
