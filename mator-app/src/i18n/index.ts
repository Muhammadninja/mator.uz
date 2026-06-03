// src/i18n/index.ts
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import ru from './locales/ru.json';
import uz from './locales/uz.json';

i18n.use(initReactI18next).init({
  compatibilityJSON: 'v4',
  lng: 'ru',
  fallbackLng: 'ru',
  resources: {
    ru: { translation: ru },
    uz: { translation: uz },
  },
  interpolation: { escapeValue: false },
});

export default i18n;
