import { Prisma } from '@prisma/client';

type Db = Prisma.TransactionClient;

/** The three transports a device row can carry a token for. */
export interface PushTokens {
  expoPushToken?: string | null;
  fcmToken?: string | null;
  apnsToken?: string | null;
}

const NO_TOKENS = { expoPushToken: null, fcmToken: null, apnsToken: null };

/**
 * Make `deviceId` the only device row holding these push tokens.
 *
 * A push token identifies one app install, whoever is signed in on it. When a
 * second account signs in on the same phone, the install registers the same
 * token under the new account; left alone, the previous account's row would
 * keep it and every notification for either account would reach that phone.
 * The token is therefore taken off every other row, so it follows the account
 * that registered it last. Call inside the transaction that writes the token.
 */
export async function claimPushTokens(
  db: Db,
  deviceId: string,
  tokens: PushTokens,
): Promise<void> {
  const columns = ['expoPushToken', 'fcmToken', 'apnsToken'] as const;
  for (const column of columns) {
    const token = tokens[column];
    if (!token) continue;
    await db.device.updateMany({
      where: { [column]: token, id: { not: deviceId } },
      data: { [column]: null },
    });
  }
}

/**
 * Stop pushing to the device a session was signed out on. The row stays, with
 * its metadata, and its tokens are cleared; the next sign-in on that install
 * registers them again. Scoped to `userId`, so a caller can only ever silence
 * its own devices. Returns how many rows were cleared.
 */
export async function releasePushTokens(
  db: Db,
  userId: string,
  device: { deviceId?: string | null; installId?: string | null },
): Promise<number> {
  const match: Prisma.DeviceWhereInput[] = [];
  if (device.deviceId) match.push({ id: device.deviceId });
  if (device.installId) match.push({ installId: device.installId });
  if (match.length === 0) return 0;
  const { count } = await db.device.updateMany({
    where: { userId, OR: match },
    data: NO_TOKENS,
  });
  return count;
}

/** Stop pushing to every device of an account (sign out everywhere). */
export async function releaseAllPushTokens(
  db: Db,
  userId: string,
): Promise<number> {
  const { count } = await db.device.updateMany({
    where: { userId },
    data: NO_TOKENS,
  });
  return count;
}
