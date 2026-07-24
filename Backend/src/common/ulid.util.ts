import { ulid } from 'ulid';

/**
 * Prefixed ULID generator matching the frontend contract's ID strategy
 * (e.g. veh_01HXC3KF…, ord_01HXC3KR…). The prefix encodes the entity type
 * and the ULID body is lexicographically sortable by creation time.
 */
export const IdPrefix = {
  VEHICLE: 'veh',
  ORDER: 'ord',
  ORDER_ITEM: 'oi',
  ORDER_STATUS_HISTORY: 'osh',
  PAYMENT: 'pay',
  BOOKING: 'bk',
  BOOKING_SERVICE: 'bks',
  CART: 'cart',
  CART_ITEM: 'item',
  AI_SESSION: 'ai',
  AI_MESSAGE: 'msg',
  NOTIFICATION: 'ntf',
  NOTIFICATION_PREF: 'npref',
  DEVICE: 'dev',
  ADDRESS: 'addr',
  OTP: 'otp',
  MYID_SESSION: 'myid_sess',
  MYID_VERIFICATION: 'myid_ver',
  REFRESH: 'rt',
  PROVIDER: 'prov',
  SERVICE: 'svc',
  CATALOG_PART: 'part',
} as const;

export type IdPrefix = (typeof IdPrefix)[keyof typeof IdPrefix];

/** Generate a prefixed ULID, e.g. prefixedId(IdPrefix.VEHICLE) -> "veh_01HX…". */
export function prefixedId(prefix: IdPrefix): string {
  return `${prefix}_${ulid()}`;
}
