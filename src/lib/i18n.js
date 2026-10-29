/**
 * MVM Panel - Internationalization (i18n) Engine
 */

const LOCALES = {
  en: {
    name: 'English',
    rtl: false,
    translations: {
      dashboard: 'Dashboard',
      servers: 'Servers',
      users: 'Users',
      storage: 'Storage',
      network: 'Network',
      billing: 'Billing',
      settings: 'Settings',
      plugins: 'Plugins',
      audit: 'Audit & Security',
      logout: 'Logout',
      create_server: 'New Server',
      online: 'Online',
      offline: 'Offline',
      running: 'Running',
      stopped: 'Stopped',
      console: 'Console & Terminal',
      backups: 'Backups',
      schedules: 'Schedules',
      impersonate: 'Login as User',
      ai_diagnose: 'AI Diagnostics',
      command_palette_hint: 'Type a command or search...',
    },
  },
  hi: {
    name: 'हिन्दी (Hindi)',
    rtl: false,
    translations: {
      dashboard: 'डैशबोर्ड',
      servers: 'सर्वर',
      users: 'उपयोगकर्ता',
      storage: 'स्टोरेज',
      network: 'नेटवर्क',
      billing: 'बिलिंग और योजनाएं',
      settings: 'सेटिंग्स',
      plugins: 'प्लगइन्स',
      audit: 'सुरक्षा और ऑडिट',
      logout: 'लॉग आउट',
      create_server: 'नया सर्वर',
      online: 'ऑनलाइन',
      offline: 'ऑफलाइन',
      running: 'सक्रिय (Running)',
      stopped: 'बंद (Stopped)',
      console: 'कंसोल और टर्मिनल',
      backups: 'बैकअप',
      schedules: 'शेड्यूल',
      impersonate: 'यूज़र के रूप में लॉगिन करें',
      ai_diagnose: 'एआई समस्या निवारण',
      command_palette_hint: 'कमांड टाइप करें या खोजें...',
    },
  },
  es: {
    name: 'Español',
    rtl: false,
    translations: {
      dashboard: 'Panel',
      servers: 'Servidores',
      users: 'Usuarios',
      storage: 'Almacenamiento',
      network: 'Red',
      billing: 'Facturación',
      settings: 'Ajustes',
      plugins: 'Extensiones',
      audit: 'Seguridad y Auditoría',
      logout: 'Cerrar sesión',
      create_server: 'Nuevo Servidor',
      online: 'En línea',
      offline: 'Desconectado',
      running: 'En ejecución',
      stopped: 'Detenido',
      console: 'Consola y Terminal',
      backups: 'Copias de seguridad',
      schedules: 'Programaciones',
      impersonate: 'Iniciar sesión como usuario',
      ai_diagnose: 'Diagnóstico IA',
      command_palette_hint: 'Escribe un comando o busca...',
    },
  },
  de: {
    name: 'Deutsch',
    rtl: false,
    translations: {
      dashboard: 'Übersicht',
      servers: 'Server',
      users: 'Benutzer',
      storage: 'Speicher',
      network: 'Netzwerk',
      billing: 'Abrechnung',
      settings: 'Einstellungen',
      plugins: 'Erweiterungen',
      audit: 'Sicherheit & Audit',
      logout: 'Abmelden',
      create_server: 'Neuer Server',
      online: 'Online',
      offline: 'Offline',
      running: 'Aktiv',
      stopped: 'Gestoppt',
      console: 'Konsole & Terminal',
      backups: 'Sicherungen',
      schedules: 'Zeitpläne',
      impersonate: 'Als Benutzer anmelden',
      ai_diagnose: 'KI-Diagnose',
      command_palette_hint: 'Befehl eingeben oder suchen...',
    },
  },
  ar: {
    name: 'العربية (Arabic)',
    rtl: true,
    translations: {
      dashboard: 'لوحة التحكم',
      servers: 'الخوادم',
      users: 'المستخدمين',
      storage: 'التخزين',
      network: 'الشبكة',
      billing: 'الفواتير والخطط',
      settings: 'الإعدادات',
      plugins: 'الإضافات',
      audit: 'الأمان والتدقيق',
      logout: 'تسجيل الخروج',
      create_server: 'خادم جديد',
      online: 'متصل',
      offline: 'غير متصل',
      running: 'قيد التشغيل',
      stopped: 'متوقف',
      console: 'الطرفية والشاشة',
      backups: 'النسخ الاحتياطية',
      schedules: 'الجداول المحددة',
      impersonate: 'تسجيل الدخول كمستخدم',
      ai_diagnose: 'تشخيص الذكاء الاصطناعي',
      command_palette_hint: 'اكتب أمراً أو ابحث...',
    },
  },
};

function translate(key, locale = 'en') {
  const loc = LOCALES[locale] || LOCALES.en;
  if (loc.translations && loc.translations[key]) {
    return loc.translations[key];
  }
  return LOCALES.en.translations[key] || key;
}

function i18nMiddleware(req, res, next) {
  let lang = req.cookies?.vpanel_lang || 'en';
  if (!LOCALES[lang]) lang = 'en';

  res.locals.__ = (key) => translate(key, lang);
  res.locals.t = res.locals.__;
  res.locals.currentLang = lang;
  res.locals.isRTL = Boolean(LOCALES[lang]?.rtl);
  res.locals.availableLocales = Object.keys(LOCALES).map(code => ({
    code,
    name: LOCALES[code].name,
    rtl: LOCALES[code].rtl,
  }));

  next();
}

module.exports = {
  LOCALES,
  translate,
  t: translate,
  i18nMiddleware,
};
