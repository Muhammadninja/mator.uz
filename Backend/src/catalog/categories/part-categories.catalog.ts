import { PartMainCategory, PartVehicleCategory } from '@prisma/client';

// Presentation metadata for the two-level part category hierarchy. The enum is
// the stored source of truth; these entries add the display name, slug, icon key
// and accent color the frontend renders (matching the backend.json contract's
// categories_response item shape). Order here is the display order.

export interface CategoryMeta {
  /** Stored enum value (also used as the stable id). */
  id: PartMainCategory | PartVehicleCategory;
  name: string;
  slug: string;
  iconKey: string;
  color: string;
}

// Home-page grid — every part belongs to exactly one of these.
export const MAIN_CATEGORIES: { id: PartMainCategory; name: string; slug: string; iconKey: string; color: string }[] = [
  { id: PartMainCategory.BRAKES, name: 'Brakes', slug: 'brakes', iconKey: 'brakes', color: '#EA4335' },
  { id: PartMainCategory.BATTERIES, name: 'Batteries', slug: 'batteries', iconKey: 'batteries', color: '#FBBC04' },
  { id: PartMainCategory.FILTERS, name: 'Filters', slug: 'filters', iconKey: 'filters', color: '#34A853' },
  { id: PartMainCategory.IGNITION, name: 'Ignition', slug: 'ignition', iconKey: 'ignition', color: '#FF6D01' },
  { id: PartMainCategory.ENGINE, name: 'Engine', slug: 'engine', iconKey: 'engine', color: '#4285F4' },
  { id: PartMainCategory.ELECTRICAL_PARTS, name: 'Electrical Parts', slug: 'electrical-parts', iconKey: 'electrical', color: '#A142F4' },
  { id: PartMainCategory.OIL_AND_FLUIDS, name: 'Oil & Fluids', slug: 'oil-and-fluids', iconKey: 'oil', color: '#00ACC1' },
  { id: PartMainCategory.BELTS_AND_HOSES, name: 'Belts & Hoses', slug: 'belts-and-hoses', iconKey: 'belts', color: '#795548' },
  { id: PartMainCategory.WIPERS, name: 'Wipers', slug: 'wipers', iconKey: 'wipers', color: '#607D8B' },
  { id: PartMainCategory.LIGHTING, name: 'Lighting', slug: 'lighting', iconKey: 'lighting', color: '#F9AB00' },
  { id: PartMainCategory.SUSPENSION, name: 'Suspension', slug: 'suspension', iconKey: 'suspension', color: '#009688' },
  { id: PartMainCategory.EXTERIOR, name: 'Exterior', slug: 'exterior', iconKey: 'exterior', color: '#5F6368' },
];

// Vehicle-specific grouping shown after a make/model is chosen.
export const VEHICLE_CATEGORIES: { id: PartVehicleCategory; name: string; slug: string; iconKey: string; color: string }[] = [
  { id: PartVehicleCategory.BRAKE_SYSTEM, name: 'Brake System', slug: 'brake-system', iconKey: 'brakes', color: '#EA4335' },
  { id: PartVehicleCategory.MAINTENANCE_AND_FLUIDS, name: 'Maintenance & Fluids', slug: 'maintenance-and-fluids', iconKey: 'oil', color: '#00ACC1' },
  { id: PartVehicleCategory.SUSPENSION_AND_STEERING, name: 'Suspension & Steering', slug: 'suspension-and-steering', iconKey: 'suspension', color: '#009688' },
  { id: PartVehicleCategory.ELECTRICAL_AND_LIGHTING, name: 'Electrical & Lighting', slug: 'electrical-and-lighting', iconKey: 'electrical', color: '#A142F4' },
  { id: PartVehicleCategory.ENGINE, name: 'Engine', slug: 'engine', iconKey: 'engine', color: '#4285F4' },
  { id: PartVehicleCategory.TRANSMISSION, name: 'Transmission', slug: 'transmission', iconKey: 'transmission', color: '#3F51B5' },
  { id: PartVehicleCategory.HEATING_AND_COOLING, name: 'Heating & Cooling', slug: 'heating-and-cooling', iconKey: 'cooling', color: '#03A9F4' },
  { id: PartVehicleCategory.TUNING_AND_ACCESSORIES, name: 'Tuning & Accessories', slug: 'tuning-and-accessories', iconKey: 'tuning', color: '#9C27B0' },
];
