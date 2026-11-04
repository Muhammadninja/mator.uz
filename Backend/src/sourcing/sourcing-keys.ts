import { expandToken } from '../ai-chat/part-synonyms.util';

/** Same part however it's phrased: "Oil filter" and "фильтр масляный" can match. */
export function sourcingPartKey(partName: string): string {
  const tokens = partName
    .toLowerCase()
    .split(/[^\p{L}\p{N}-]+/u)
    .filter((t) => t.length >= 2);
  const canonical = tokens.map((t) => [...expandToken(t)].sort()[0]);
  return [...new Set(canonical)].sort().join(' ');
}

/** Which car a request is for. Requests for different cars must never merge. */
export function sourcingVehicleKey(input: {
  vehicleId: string | null;
  brand: string | null;
  model: string | null;
  year: string | null;
}): string {
  if (input.vehicleId) return `vehicle:${input.vehicleId}`;
  const named = [input.brand, input.model, input.year]
    .map((v) => v?.trim().toLowerCase() ?? '')
    .join('|');
  return named === '||' ? 'none' : `named:${named}`.slice(0, 200);
}

/** Identifies the car's type for dealers, leaving out the unit's serial number. */
export function maskVin(vin: string): string {
  const clean = vin.trim();
  return clean.length > 11 ? `${clean.slice(0, 11)}******` : '******';
}
