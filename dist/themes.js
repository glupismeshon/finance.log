(function (root) {
  "use strict";
  // 23 палитры (известные темы редакторов), набор как в init.Tasks.
  // c: bg, accent, headers, text, comment (= --muted), separator (= --border), warn, cyan.
  const THEMES = [
    {"id": "githubDark", "name": "github dark", "dark": true, "c": {"bg": "#0D1117", "accent": "#34C48A", "headers": "#58A6FF", "text": "#E6EDF3", "comment": "#747D88", "separator": "#21262D", "warn": "#D29922", "cyan": "#56D4DD"}},
    {"id": "catppuccinMocha", "name": "catppuccin mocha", "dark": true, "c": {"bg": "#1E1E2E", "accent": "#A6E3A1", "headers": "#CBA6F7", "text": "#CDD6F4", "comment": "#81869D", "separator": "#313244", "warn": "#FAB387", "cyan": "#89DCEB"}},
    {"id": "ansiDark", "name": "ansi dark", "dark": true, "c": {"bg": "#000000", "accent": "#4CE64C", "headers": "#6699FF", "text": "#FFFFFF", "comment": "#8A8A8A", "separator": "#333333", "warn": "#E6E64C", "cyan": "#4CE6E6"}},
    {"id": "solarizedCream", "name": "solarized cream", "dark": true, "c": {"bg": "#1A1610", "accent": "#B58900", "headers": "#268BD2", "text": "#FDF6E3", "comment": "#6C838C", "separator": "#2A2318", "warn": "#CB4B16", "cyan": "#2AA198"}},
    {"id": "dracula", "name": "dracula", "dark": true, "c": {"bg": "#282A36", "accent": "#50FA7B", "headers": "#BD93F9", "text": "#F8F8F2", "comment": "#8390B7", "separator": "#44475A", "warn": "#FFB86C", "cyan": "#8BE9FD"}},
    {"id": "nord", "name": "nord", "dark": true, "c": {"bg": "#2E3440", "accent": "#A3BE8C", "headers": "#81A1C1", "text": "#ECEFF4", "comment": "#919CB1", "separator": "#3B4252", "warn": "#EBCB8B", "cyan": "#88C0D0"}},
    {"id": "tokyoNight", "name": "tokyo night", "dark": true, "c": {"bg": "#1A1B26", "accent": "#9ECE6A", "headers": "#7AA2F7", "text": "#A9B1D6", "comment": "#7981AB", "separator": "#292E42", "warn": "#E0AF68", "cyan": "#7DCFFF"}},
    {"id": "gruvboxDark", "name": "gruvbox dark", "dark": true, "c": {"bg": "#282828", "accent": "#B8BB26", "headers": "#83A598", "text": "#EBDBB2", "comment": "#9A8C7E", "separator": "#3C3836", "warn": "#FE8019", "cyan": "#8EC07C"}},
    {"id": "monokai", "name": "monokai", "dark": true, "c": {"bg": "#272822", "accent": "#A6E22E", "headers": "#66D9EF", "text": "#F8F8F2", "comment": "#928E78", "separator": "#3E3D32", "warn": "#FD971F", "cyan": "#66D9EF"}},
    {"id": "oneDark", "name": "one dark", "dark": true, "c": {"bg": "#282C34", "accent": "#98C379", "headers": "#61AFEF", "text": "#ABB2BF", "comment": "#8B93A0", "separator": "#3E4451", "warn": "#E5C07B", "cyan": "#56B6C2"}},
    {"id": "ayuDark", "name": "ayu dark", "dark": true, "c": {"bg": "#0D1017", "accent": "#E6B450", "headers": "#59C2FF", "text": "#BFBDB6", "comment": "#747C86", "separator": "#1C2029", "warn": "#FFB454", "cyan": "#95E6CB"}},
    {"id": "ayuMirage", "name": "ayu mirage", "dark": true, "c": {"bg": "#1F2430", "accent": "#FFD580", "headers": "#73D0FF", "text": "#CCCAC2", "comment": "#7F8C99", "separator": "#2A2F3A", "warn": "#FFA759", "cyan": "#95E6CB"}},
    {"id": "kanagawa", "name": "kanagawa", "dark": true, "c": {"bg": "#1F1F28", "accent": "#98BB6C", "headers": "#957FB8", "text": "#DCD7BA", "comment": "#88877E", "separator": "#2A2A37", "warn": "#E82424", "cyan": "#7FB4CA"}},
    {"id": "everforestDark", "name": "everforest dark", "dark": true, "c": {"bg": "#2D353B", "accent": "#A7C080", "headers": "#7FBBB3", "text": "#D3C6AA", "comment": "#939F97", "separator": "#374145", "warn": "#DBBC7F", "cyan": "#83C092"}},
    {"id": "materialDark", "name": "material dark", "dark": true, "c": {"bg": "#263238", "accent": "#C3E88D", "headers": "#82AAFF", "text": "#EEFFFF", "comment": "#819CA8", "separator": "#37474F", "warn": "#FFCB6B", "cyan": "#89DDFF"}},
    {"id": "lightBasic", "name": "light basic", "dark": false, "c": {"bg": "#FFFFFF", "accent": "#007F00", "headers": "#0000CC", "text": "#000000", "comment": "#757575", "separator": "#DDDDDD", "warn": "#757500", "cyan": "#007F7F"}},
    {"id": "solarizedLight", "name": "solarized light", "dark": false, "c": {"bg": "#FDF6E3", "accent": "#859900", "headers": "#268BD2", "text": "#073642", "comment": "#5F747C", "separator": "#EEE8D5", "warn": "#B58900", "cyan": "#2AA198"}},
    {"id": "githubLight", "name": "github light", "dark": false, "c": {"bg": "#FFFFFF", "accent": "#1A7F37", "headers": "#0969DA", "text": "#1F2328", "comment": "#656D76", "separator": "#D0D7DE", "warn": "#9A6700", "cyan": "#0550AE"}},
    {"id": "rosePineDawn", "name": "rosé pine dawn", "dark": false, "c": {"bg": "#FAF4ED", "accent": "#56949F", "headers": "#EA9D34", "text": "#575279", "comment": "#736D83", "separator": "#F2E9DE", "warn": "#D7827E", "cyan": "#56949F"}},
    {"id": "oneLight", "name": "one light", "dark": false, "c": {"bg": "#FAFAFA", "accent": "#50A14F", "headers": "#4078F2", "text": "#383A42", "comment": "#72737B", "separator": "#E5E5E6", "warn": "#C18401", "cyan": "#0184BC"}},
    {"id": "ayuLight", "name": "ayu light", "dark": false, "c": {"bg": "#FAFAFA", "accent": "#F2AE49", "headers": "#399EE6", "text": "#5C6166", "comment": "#6D747D", "separator": "#E7E8E9", "warn": "#F2AE49", "cyan": "#4CBF99"}},
    {"id": "everforestLight", "name": "everforest light", "dark": false, "c": {"bg": "#FDF6E3", "accent": "#8DA101", "headers": "#3A94C5", "text": "#5C6A72", "comment": "#687566", "separator": "#E5DFC5", "warn": "#DFA000", "cyan": "#35A77C"}},
    {"id": "catppuccinLatte", "name": "catppuccin latte", "dark": false, "c": {"bg": "#EFF1F5", "accent": "#40A02B", "headers": "#8839EF", "text": "#4C4F69", "comment": "#686D82", "separator": "#DCE0E8", "warn": "#DF8E1D", "cyan": "#179299"}}
  ];
  const api = {THEMES, DEFAULT_DARK: "githubDark", DEFAULT_LIGHT: "ayuLight"};
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else (root.MoneyCore = root.MoneyCore || {}).themes = api;
})(globalThis);
