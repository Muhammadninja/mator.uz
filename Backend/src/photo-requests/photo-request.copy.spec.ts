import { photoReplyLanguage, photoReplyText } from './photo-request.copy';

describe('photoReplyLanguage', () => {
  it('reads the interface language off the first line, not the Russian product name', () => {
    expect(
      photoReplyLanguage(
        'Please request a current photo of this product:\nProduct: Уплотнитель передней двери\nOEM: 94779211',
      ),
    ).toBe('en');
    expect(photoReplyLanguage('Пожалуйста, запросите актуальное фото товара:\nТовар: Seal')).toBe('ru');
    expect(photoReplyLanguage('Iltimos, mahsulotning dolzarb suratini soʻrang:\nMahsulot: Уплотнитель')).toBe('uz_lat');
    expect(photoReplyLanguage('\n  \nPlease request a current photo')).toBe('en');
  });

  it('has a reply in every language', () => {
    expect(photoReplyText('REQUESTED', 'en')).toMatch(/^Photo request received/);
    expect(photoReplyText('AUTH_REQUIRED', 'uz_cyr')).toMatch(/киринг/);
  });
});
