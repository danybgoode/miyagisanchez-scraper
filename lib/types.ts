export const CATEGORIES = [
  { key: 'autos', label: 'Autos y motos' },
  { key: 'inmuebles', label: 'Inmuebles' },
  { key: 'electronica', label: 'Electronica' },
  { key: 'hogar', label: 'Hogar y jardin' },
  { key: 'moda', label: 'Moda y ropa' },
  { key: 'deportes', label: 'Deportes' },
  { key: 'servicios', label: 'Servicios' },
  { key: 'mascotas', label: 'Mascotas' },
  { key: 'herramientas', label: 'Herramientas' },
  { key: 'negocios', label: 'Negocios B2B' },
  { key: 'otros', label: 'Otros' },
] as const

export const TARGET_SEARCH_SITES = [
  {
    key: 'mercadolibre',
    label: 'MercadoLibre',
    queryPrefix: 'site:mercadolibre.com.mx',
    domains: ['mercadolibre.com.mx'],
    homeUrl: 'https://www.mercadolibre.com.mx',
    parserName: 'mercadolibre_generic_html',
    defaultCategory: 'otros',
    defaultListingType: 'product',
  },
  {
    key: 'inmuebles24',
    label: 'Inmuebles24',
    queryPrefix: 'site:inmuebles24.com',
    domains: ['inmuebles24.com'],
    homeUrl: 'https://www.inmuebles24.com',
    parserName: 'inmuebles24_generic_html',
    defaultCategory: 'inmuebles',
    defaultListingType: 'rental',
  },
  {
    key: 'autocosmos',
    label: 'Autocosmos',
    queryPrefix: 'site:autocosmos.com.mx',
    domains: ['autocosmos.com.mx'],
    homeUrl: 'https://www.autocosmos.com.mx',
    parserName: 'autocosmos_generic_html',
    defaultCategory: 'autos',
    defaultListingType: 'product',
  },
  {
    key: 'seminuevos',
    label: 'Seminuevos',
    queryPrefix: 'site:seminuevos.com',
    domains: ['seminuevos.com'],
    homeUrl: 'https://www.seminuevos.com',
    parserName: 'seminuevos_generic_html',
    defaultCategory: 'autos',
    defaultListingType: 'product',
  },
] as const

export type TargetSearchSiteKey = typeof TARGET_SEARCH_SITES[number]['key']
