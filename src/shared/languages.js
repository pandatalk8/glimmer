// 语言表：统一内部代码 -> 各引擎代码
// code: 内部代码（与 Google 一致）；deepl: DeepL target 代码；ms: Microsoft 代码
export const LANGUAGES = [
  { code: 'auto', name: '自动检测', en: 'Auto Detect' },
  { code: 'zh-CN', name: '简体中文', en: 'Simplified Chinese', deepl: 'ZH-HANS', ms: 'zh-Hans' },
  { code: 'zh-TW', name: '繁體中文', en: 'Traditional Chinese', deepl: 'ZH-HANT', ms: 'zh-Hant' },
  { code: 'en', name: 'English', en: 'English', deepl: 'EN-US', ms: 'en' },
  { code: 'ja', name: '日本語', en: 'Japanese', deepl: 'JA', ms: 'ja' },
  { code: 'ko', name: '한국어', en: 'Korean', deepl: 'KO', ms: 'ko' },
  { code: 'fr', name: 'Français', en: 'French', deepl: 'FR', ms: 'fr' },
  { code: 'de', name: 'Deutsch', en: 'German', deepl: 'DE', ms: 'de' },
  { code: 'es', name: 'Español', en: 'Spanish', deepl: 'ES', ms: 'es' },
  { code: 'pt', name: 'Português', en: 'Portuguese', deepl: 'PT-BR', ms: 'pt' },
  { code: 'it', name: 'Italiano', en: 'Italian', deepl: 'IT', ms: 'it' },
  { code: 'ru', name: 'Русский', en: 'Russian', deepl: 'RU', ms: 'ru' },
  { code: 'ar', name: 'العربية', en: 'Arabic', deepl: 'AR', ms: 'ar' },
  { code: 'th', name: 'ไทย', en: 'Thai', ms: 'th' },
  { code: 'vi', name: 'Tiếng Việt', en: 'Vietnamese', ms: 'vi' },
  { code: 'id', name: 'Bahasa Indonesia', en: 'Indonesian', deepl: 'ID', ms: 'id' },
  { code: 'tr', name: 'Türkçe', en: 'Turkish', deepl: 'TR', ms: 'tr' },
  { code: 'nl', name: 'Nederlands', en: 'Dutch', deepl: 'NL', ms: 'nl' },
  { code: 'pl', name: 'Polski', en: 'Polish', deepl: 'PL', ms: 'pl' },
  { code: 'uk', name: 'Українська', en: 'Ukrainian', deepl: 'UK', ms: 'uk' },
];

export const TARGET_LANGUAGES = LANGUAGES.filter((l) => l.code !== 'auto');

export function getLang(code) {
  return LANGUAGES.find((l) => l.code === code) || { code, name: code, en: code };
}

// DeepL 源语言只接受主语言代码（ZH / EN / PT）
export function deeplSource(code) {
  if (!code || code === 'auto') return undefined;
  const l = getLang(code);
  return l.deepl ? l.deepl.split('-')[0] : undefined;
}

export function deeplTarget(code) {
  return getLang(code).deepl || code.toUpperCase();
}

export function msCode(code) {
  if (!code || code === 'auto') return '';
  return getLang(code).ms || code;
}
