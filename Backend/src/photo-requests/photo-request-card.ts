import { PhotoRequestStatus, StockSourceSystem } from '@prisma/client';

import type { PrismaService } from '../prisma/prisma.service';
import type { PhotoRequestCard } from '../telegram/telegram-notifier.service';
import { stockIdOfPartId } from '../admin/photo-coverage/photo-coverage.rules';

/** Fitment rows listed on the card; the rest are counted. */
const MAX_FITS = 5;
/** Where a part can be opened in a browser (the share link the app uses). */
const PRODUCT_URL = 'https://mator.uz/p/';

/**
 * Everything staff need to find the part and take its photo: what it is (brand,
 * numbers, category, condition), what it fits, which cars the waiting customers
 * drive, the seller and the 1C code it is stocked under, and a link to it. A part
 * that has left the catalog still gets a card, with the title it was asked by.
 */
export async function loadPhotoRequestCard(
  prisma: PrismaService,
  partId: string,
  fallbackTitle: string,
): Promise<PhotoRequestCard> {
  const [part, waitingRows, code1c] = await Promise.all([
    prisma.catalogPart.findUnique({
      where: { id: partId },
      select: {
        title: true,
        partBrandName: true,
        brand: { select: { name: true } },
        oemNumbers: true,
        gmNumbers: true,
        condition: true,
        priceUzs: true,
        isUniversal: true,
        category: { select: { nameRu: true } },
        seller: { select: { name: true } },
        fits: { select: { makeName: true, modelName: true }, orderBy: [{ makeName: 'asc' }, { modelName: 'asc' }] },
        makeFits: { select: { makeName: true }, orderBy: { makeName: 'asc' } },
      },
    }),
    prisma.photoRequest.findMany({
      where: { partId, status: PhotoRequestStatus.PENDING },
      select: { vehicleLabel: true },
    }),
    code1cOf(prisma, partId),
  ]);

  const fitNames = part
    ? part.fits.length > 0
      ? part.fits.map((f) => `${f.makeName} ${f.modelName}`)
      : part.makeFits.map((f) => f.makeName)
    : [];
  return {
    partId,
    partTitle: part?.title ?? fallbackTitle,
    brand: part?.partBrandName ?? part?.brand?.name ?? null,
    oemNumbers: part?.oemNumbers ?? [],
    gmNumbers: part?.gmNumbers ?? [],
    category: part?.category?.nameRu ?? null,
    condition: part?.condition ?? null,
    priceUzs: part ? Number(part.priceUzs) : null,
    fits: part?.isUniversal ? ['универсальная'] : fitNames.slice(0, MAX_FITS),
    moreFits: part?.isUniversal ? 0 : Math.max(0, fitNames.length - MAX_FITS),
    customerVehicles: [
      ...new Set(waitingRows.map((r) => r.vehicleLabel).filter((v): v is string => !!v)),
    ],
    seller: part?.seller?.name ?? null,
    code1c,
    waiting: waitingRows.length,
    url: part ? `${PRODUCT_URL}${encodeURIComponent(partId)}` : null,
  };
}

/** The Driver's Village 1C code a projected part is stocked under, if any. */
async function code1cOf(prisma: PrismaService, partId: string): Promise<string | null> {
  const stockId = stockIdOfPartId(partId);
  if (stockId === null) return null;
  const stock = await prisma.stock.findFirst({
    where: { id: stockId, sourceSystem: StockSourceSystem.DRIVERS_VILLAGE_1C },
    select: { sourceCode: true },
  });
  return stock?.sourceCode ?? null;
}
