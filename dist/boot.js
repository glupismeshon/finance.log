(function (root) {
  "use strict";
  // Читает настройки и применяет тему до отрисовки (подключается синхронно в <head> после themes.js).
  const KEY = "money.log.settings", OLD_THEME_KEY = "money.log.theme";
  const DEFAULTS = {lang: "auto", themeMode: "auto", darkTheme: "githubDark", lightTheme: "ayuLight", privacy: false, privacyOnStart: false, hints: true, titleAnim: true, onboardingDismissed: false};
  const themes = (root.MoneyCore && root.MoneyCore.themes) || {THEMES: [], DEFAULT_DARK: "githubDark", DEFAULT_LIGHT: "ayuLight"};
  const find = id => themes.THEMES.find(t => t.id === id);
  const listeners = [];
  let settings = {...DEFAULTS};
  let mq = null;
  try { mq = root.matchMedia("(prefers-color-scheme: dark)"); } catch {}

  function sanitize(raw) {
    const s = {...DEFAULTS};
    if (!raw || typeof raw !== "object") return s;
    if (["auto", "ru", "en"].includes(raw.lang)) s.lang = raw.lang;
    if (["auto", "dark", "light"].includes(raw.themeMode)) s.themeMode = raw.themeMode;
    if (typeof raw.privacy === "boolean") s.privacy = raw.privacy;
    if (typeof raw.privacyOnStart === "boolean") s.privacyOnStart = raw.privacyOnStart;
    if (typeof raw.hints === "boolean") s.hints = raw.hints;
    if (typeof raw.titleAnim === "boolean") s.titleAnim = raw.titleAnim;
    if (typeof raw.onboardingDismissed === "boolean") s.onboardingDismissed = raw.onboardingDismissed;
    const d = find(raw.darkTheme), l = find(raw.lightTheme);
    if (d && d.dark) s.darkTheme = d.id;
    if (l && !l.dark) s.lightTheme = l.id;
    return s;
  }
  function load() {
    try {
      const raw = root.localStorage.getItem(KEY);
      if (raw !== null) return sanitize(JSON.parse(raw));
      const old = root.localStorage.getItem(OLD_THEME_KEY);
      if (old === "paper") return {...DEFAULTS, themeMode: "light"};
      if (old === "terminal") return {...DEFAULTS, themeMode: "dark"};
    } catch {}
    return {...DEFAULTS};
  }
  function save() {
    try { root.localStorage.setItem(KEY, JSON.stringify(settings)); return true; }
    catch { return false; }
  }

  const clamp = n => Math.max(0, Math.min(255, Math.round(n)));
  const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  // share долей цвета a и (1 - share) долей цвета b
  function mix(a, b, share) {
    const x = rgb(a), y = rgb(b);
    return "#" + x.map((v, i) => clamp(v * share + y[i] * (1 - share)).toString(16).padStart(2, "0")).join("");
  }

  function resolve() {
    const dark = settings.themeMode === "dark" || (settings.themeMode === "auto" && !!(mq && mq.matches));
    const theme = find(dark ? settings.darkTheme : settings.lightTheme) || find(dark ? themes.DEFAULT_DARK : themes.DEFAULT_LIGHT) || themes.THEMES[0];
    return {dark, theme};
  }
  function apply() {
    const {dark, theme} = resolve();
    if (!theme) return;
    const c = theme.c, style = root.document.documentElement.style;
    const vars = {
      "--bg": c.bg, "--text": c.text, "--accent": c.accent, "--headers": c.headers, "--warn": c.warn, "--cyan": c.cyan,
      "--muted": c.comment, "--border": c.separator,
      "--border-dim": mix(c.separator, c.bg, 0.5), "--panel": mix(c.text, c.bg, 0.05), "--panel-2": mix(c.text, c.bg, 0.08),
      "--accent-dim": mix(c.accent, c.bg, 0.45), "--on-accent": c.bg, "--tree": mix(c.comment, c.bg, 0.6),
      "--over": dark ? "#FF7B72" : "#CF222E", "--purple": dark ? "#BC8CFF" : "#8250DF", "--orange": dark ? "#F0883E" : "#BC4C00",
      "--backdrop": "rgba(0,0,0,.6)"
    };
    for (const k in vars) style.setProperty(k, vars[k]);
    style.colorScheme = dark ? "dark" : "light";
    root.document.documentElement.dataset.dark = dark ? "1" : "0";
    root.document.documentElement.dataset.hints = settings.hints ? "on" : "off";
    const meta = root.document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = c.bg;
    listeners.forEach(fn => { try { fn({dark, theme}); } catch {} });
  }
  // patch: частичные настройки; возвращает false, если браузер не дал сохранить
  function set(patch) {
    settings = sanitize({...settings, ...patch});
    const saved = save();
    apply();
    return saved;
  }

  settings = load();
  if (settings.privacyOnStart) settings.privacy = true; // при каждом запуске режим приватности включён
  apply();
  if (mq) {
    const onChange = () => { if (settings.themeMode === "auto") apply(); };
    if (mq.addEventListener) mq.addEventListener("change", onChange); else if (mq.addListener) mq.addListener(onChange);
  }
  // настройки могут измениться в другой вкладке
  root.addEventListener("storage", event => {
    if (event.key !== KEY) return;
    settings = load(); apply();
  });

  const api = {KEY, DEFAULTS, mix, resolve, get: () => ({...settings}), themes: () => themes.THEMES, set, onChange: fn => listeners.push(fn)};
  (root.MoneyCore = root.MoneyCore || {}).boot = api;
})(globalThis);
