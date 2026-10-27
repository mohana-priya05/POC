import prisma from '../utils/prisma';

export interface ChatProduct {
  id: string;
  name: string;
  description: string;
  pricePaise: number;
  priceInr: number;
  image: string | null;
  stock: number;
  inStock: boolean;
  category: string | null;
}

export interface SearchArgs {
  query?: string;
  category?: string;
  maxPriceInr?: number;
  minPriceInr?: number;
  inStockOnly?: boolean;
  limit?: number;
}

const STOPWORDS = new Set(['a', 'an', 'the', 'me', 'show', 'i', 'need', 'want', 'some', 'for', 'under', 'below', 'and', 'of', 'to', 'buy', 'please']);

const toChatProduct = (p: any): ChatProduct => ({
  id: p.id,
  name: p.name,
  description: String(p.description ?? '').slice(0, 160),
  pricePaise: p.pricePaise,
  priceInr: p.pricePaise / 100,
  image: Array.isArray(p.images) && p.images[0] ? String(p.images[0]) : null,
  stock: p.stock,
  inStock: p.stock > 0,
  category: p.category?.name ?? null,
});

/** Reads products straight from the database; prices and stock never come from the model. */
export const searchCatalog = async (args: SearchArgs): Promise<ChatProduct[]> => {
  const limit = Math.min(6, Math.max(1, Math.floor(args.limit ?? 6)));
  const base: any = { active: true };
  const price: any = {};
  if (typeof args.maxPriceInr === 'number' && args.maxPriceInr > 0) price.lte = Math.round(args.maxPriceInr * 100);
  if (typeof args.minPriceInr === 'number' && args.minPriceInr > 0) price.gte = Math.round(args.minPriceInr * 100);
  if (Object.keys(price).length) base.pricePaise = price;
  if (args.inStockOnly) base.stock = { gt: 0 };
  if (args.category?.trim()) {
    const c = args.category.trim();
    base.category = { OR: [{ name: { contains: c } }, { slug: { contains: c } }] };
  }

  const tokens = (args.query ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 1 && !STOPWORDS.has(t))
    .slice(0, 6);
  const tokenClause = (t: string) => ({
    OR: [{ name: { contains: t } }, { description: { contains: t } }, { category: { name: { contains: t } } }],
  });

  const run = (where: any) =>
    prisma.product.findMany({ where, include: { category: true }, orderBy: [{ stock: 'desc' }, { pricePaise: 'asc' }], take: limit });

  if (!tokens.length) return (await run(base)).map(toChatProduct);

  let rows = await run({ ...base, AND: tokens.map(tokenClause) });
  if (!rows.length && tokens.length > 1) rows = await run({ ...base, OR: tokens.map(tokenClause) });
  return rows.map(toChatProduct);
};

export const listCategories = async () => {
  const cats = await prisma.category.findMany({ include: { _count: { select: { products: true } } }, orderBy: { name: 'asc' } });
  return cats.map(c => ({ name: c.name, slug: c.slug, productCount: c._count.products }));
};
