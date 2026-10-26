import { localName, type Language } from '../i18n';

/**
 * Hand-placed sea and ocean names for the map. Anchors sit in open water, not on a coastline.
 * rank 0 = oceans (shown at world zoom), 1 = major seas and gulfs, 2 = marginal seas, bays and straits, 3 = small bays and channels.
 * The sea between Korea and Japan is the East Sea (동해) here.
 * Korean names live here as `nameKo`; ja, zh-CN and zh-TW names come from the locale tables, keyed by `name`.
 */
export interface Sea {
  name: string;
  nameKo: string;
  lon: number;
  lat: number;
  rank: 0 | 1 | 2 | 3;
}

export const SEAS: Sea[] = [
  { name: 'North Pacific Ocean', nameKo: '북태평양', lon: -160, lat: 33, rank: 0 },
  { name: 'South Pacific Ocean', nameKo: '남태평양', lon: -135, lat: -25, rank: 0 },
  { name: 'North Atlantic Ocean', nameKo: '북대서양', lon: -42, lat: 32, rank: 0 },
  { name: 'South Atlantic Ocean', nameKo: '남대서양', lon: -15, lat: -22, rank: 0 },
  { name: 'Indian Ocean', nameKo: '인도양', lon: 80, lat: -15, rank: 0 },
  { name: 'Southern Ocean', nameKo: '남극해', lon: 60, lat: -62, rank: 0 },
  { name: 'Arctic Ocean', nameKo: '북극해', lon: -150, lat: 82, rank: 0 },

  { name: 'East Sea', nameKo: '동해', lon: 135.5, lat: 39.5, rank: 1 },
  { name: 'Yellow Sea', nameKo: '황해', lon: 123.5, lat: 35.5, rank: 1 },
  { name: 'East China Sea', nameKo: '동중국해', lon: 125.5, lat: 28.5, rank: 1 },
  { name: 'South China Sea', nameKo: '남중국해', lon: 113, lat: 14, rank: 1 },
  { name: 'Philippine Sea', nameKo: '필리핀해', lon: 132, lat: 18, rank: 1 },
  { name: 'Sea of Okhotsk', nameKo: '오호츠크해', lon: 148, lat: 54, rank: 1 },
  { name: 'Bering Sea', nameKo: '베링해', lon: -175, lat: 58, rank: 1 },
  { name: 'Bay of Bengal', nameKo: '벵골만', lon: 88, lat: 14, rank: 1 },
  { name: 'Arabian Sea', nameKo: '아라비아해', lon: 64, lat: 15, rank: 1 },
  { name: 'Mediterranean Sea', nameKo: '지중해', lon: 18, lat: 35, rank: 1 },
  { name: 'Caribbean Sea', nameKo: '카리브해', lon: -75, lat: 15, rank: 1 },
  { name: 'Gulf of Mexico', nameKo: '멕시코만', lon: -90, lat: 25, rank: 1 },
  { name: 'Caspian Sea', nameKo: '카스피해', lon: 51, lat: 42, rank: 1 },
  { name: 'Black Sea', nameKo: '흑해', lon: 34, lat: 43.3, rank: 1 },
  { name: 'North Sea', nameKo: '북해', lon: 3, lat: 56, rank: 1 },
  { name: 'Norwegian Sea', nameKo: '노르웨이해', lon: 3, lat: 67, rank: 1 },
  { name: 'Hudson Bay', nameKo: '허드슨만', lon: -85, lat: 60, rank: 1 },
  { name: 'Coral Sea', nameKo: '산호해', lon: 154, lat: -17, rank: 1 },
  { name: 'Tasman Sea', nameKo: '태즈먼해', lon: 160, lat: -38, rank: 1 },

  { name: 'Korea Strait', nameKo: '대한해협', lon: 129, lat: 34.3, rank: 2 },
  { name: 'Taiwan Strait', nameKo: '타이완 해협', lon: 119.5, lat: 24.5, rank: 2 },
  { name: 'Gulf of Thailand', nameKo: '타이만', lon: 101.5, lat: 10.5, rank: 2 },
  { name: 'Java Sea', nameKo: '자바해', lon: 110, lat: -5, rank: 2 },
  { name: 'Celebes Sea', nameKo: '셀레베스해', lon: 122, lat: 3, rank: 2 },
  { name: 'Sulu Sea', nameKo: '술루해', lon: 120, lat: 9, rank: 2 },
  { name: 'Banda Sea', nameKo: '반다해', lon: 127, lat: -5.5, rank: 2 },
  { name: 'Arafura Sea', nameKo: '아라푸라해', lon: 135, lat: -9, rank: 2 },
  { name: 'Red Sea', nameKo: '홍해', lon: 38.5, lat: 20, rank: 2 },
  { name: 'Persian Gulf', nameKo: '페르시아만', lon: 51.5, lat: 27, rank: 2 },
  { name: 'Gulf of Aden', nameKo: '아덴만', lon: 48, lat: 12.5, rank: 2 },
  { name: 'Mozambique Channel', nameKo: '모잠비크 해협', lon: 41, lat: -19, rank: 2 },
  { name: 'Tyrrhenian Sea', nameKo: '티레니아해', lon: 12, lat: 40, rank: 2 },
  { name: 'Adriatic Sea', nameKo: '아드리아해', lon: 15.5, lat: 42.5, rank: 2 },
  { name: 'Aegean Sea', nameKo: '에게해', lon: 25, lat: 38.5, rank: 2 },
  { name: 'Baltic Sea', nameKo: '발트해', lon: 19, lat: 57.5, rank: 2 },
  { name: 'Labrador Sea', nameKo: '래브라도해', lon: -54, lat: 58, rank: 2 },
  { name: 'Gulf of Alaska', nameKo: '알래스카만', lon: -146, lat: 57.5, rank: 2 },
  { name: 'Gulf of California', nameKo: '캘리포니아만', lon: -110, lat: 25, rank: 2 },
  { name: 'Bohai Sea', nameKo: '보하이해', lon: 119.5, lat: 38.5, rank: 2 },
  { name: 'East Siberian Sea', nameKo: '동시베리아해', lon: 165, lat: 72, rank: 2 },
  { name: 'Laptev Sea', nameKo: '랍테프해', lon: 125, lat: 76, rank: 2 },
  { name: 'Kara Sea', nameKo: '카라해', lon: 72, lat: 75, rank: 2 },
  { name: 'Barents Sea', nameKo: '바렌츠해', lon: 40, lat: 74, rank: 2 },

  { name: 'Seto Inland Sea', nameKo: '세토 내해', lon: 133, lat: 34.1, rank: 3 },
];

export const seaName = (s: Sea, lang: Language): string => (lang === 'ko' ? s.nameKo : localName(s.name, lang));

/** Minimum web zoom (see `webZoom`) at which each rank is labelled. */
export const SEA_MIN_ZOOM: Record<Sea['rank'], number> = { 0: -Infinity, 1: 3.3, 2: 4, 3: 5.5 };
