import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Create categories
  const categories = await Promise.all([
    prisma.category.upsert({
      where: { slug: 'men' },
      update: {},
      create: { name: 'Men', slug: 'men' },
    }),
    prisma.category.upsert({
      where: { slug: 'women' },
      update: {},
      create: { name: 'Women', slug: 'women' },
    }),
    prisma.category.upsert({
      where: { slug: 'kids' },
      update: {},
      create: { name: 'Kids', slug: 'kids' },
    }),
    prisma.category.upsert({
      where: { slug: 'accessories' },
      update: {},
      create: { name: 'Accessories', slug: 'accessories' },
    }),
  ]);

  const catMap = Object.fromEntries(categories.map(c => [c.slug, c.id]));

  const products = [
    { name: 'Classic Cotton T-Shirt', slug: 'classic-cotton-tshirt', description: 'Soft, breathable cotton t-shirt for everyday wear.', pricePaise: 79900, stock: 50, category: 'men', images: ['https://images.unsplash.com/photo-1521572267360-ee0c2909d518?w=800'] },
    { name: 'Denim Jeans Slim Fit', slug: 'denim-jeans-slim-fit', description: 'Slim fit denim jeans with stretch comfort.', pricePaise: 249900, stock: 40, category: 'men', images: ['https://images.unsplash.com/photo-1544441893-675973e31985?w=800'] },
    { name: 'Casual Chinos', slug: 'casual-chinos', description: 'Versatile chinos perfect for work or weekend.', pricePaise: 199900, stock: 60, category: 'men', images: ['https://images.unsplash.com/photo-1598033129183-c4f50c736f10?w=800'] },
    { name: 'Hooded Sweatshirt', slug: 'hooded-sweatshirt', description: 'Cozy hoodie with kangaroo pocket.', pricePaise: 179900, stock: 45, category: 'men', images: ['https://images.unsplash.com/photo-1556821840-3a63f95609a7?w=800'] },
    { name: 'Polo Shirt', slug: 'polo-shirt', description: 'Classic polo shirt with ribbed collar.', pricePaise: 129900, stock: 55, category: 'men', images: ['https://images.unsplash.com/photo-1586363104862-3a5e2ab60d99?w=800'] },
    { name: 'Floral Summer Dress', slug: 'floral-summer-dress', description: 'Light and breezy floral dress for summer.', pricePaise: 229900, stock: 35, category: 'women', images: ['https://images.unsplash.com/photo-1515372039744-b8f02a3ae446?w=800'] },
    { name: 'Denim Jacket Women', slug: 'denim-jacket-women', description: 'Trendy oversized denim jacket.', pricePaise: 279900, stock: 30, category: 'women', images: ['https://images.unsplash.com/photo-1551028719-00167b16eac5?w=800'] },
    { name: 'High Waist Leggings', slug: 'high-waist-leggings', description: 'Comfortable high-waist leggings for yoga or casual wear.', pricePaise: 149900, stock: 80, category: 'women', images: ['https://images.unsplash.com/photo-1506629082955-511b1aa562c8?w=800'] },
    { name: 'Blouse Top', slug: 'blouse-top', description: 'Elegant blouse with puff sleeves.', pricePaise: 159900, stock: 65, category: 'women', images: ['https://images.unsplash.com/photo-1598033129183-c4f50c736f10?w=800'] },
    { name: 'Midi Skirt', slug: 'midi-skirt', description: 'Flowing midi skirt with side slit.', pricePaise: 189900, stock: 50, category: 'women', images: ['https://images.unsplash.com/photo-1583496661160-fb5886a0aaaa?w=800'] },
    { name: 'Kids Graphic Tee', slug: 'kids-graphic-tee', description: 'Fun graphic tee for kids.', pricePaise: 69900, stock: 90, category: 'kids', images: ['https://images.unsplash.com/photo-1519278409-1f56fdda7fe5?w=800'] },
    { name: 'Kids Cargo Shorts', slug: 'kids-cargo-shorts', description: 'Durable cargo shorts for active kids.', pricePaise: 89900, stock: 75, category: 'kids', images: ['https://images.unsplash.com/photo-1503944583220-79d8926ad5e2?w=800'] },
    { name: 'Kids Hoodie', slug: 'kids-hoodie', description: 'Warm and comfy hoodie for kids.', pricePaise: 119900, stock: 70, category: 'kids', images: ['https://images.unsplash.com/photo-1519238263530-99bdd11df2ea?w=800'] },
    { name: 'Leather Belt', slug: 'leather-belt', description: 'Genuine leather belt with classic buckle.', pricePaise: 99900, stock: 100, category: 'accessories', images: ['https://images.unsplash.com/photo-1553062407-98eeb64c6a62?w=800'] },
    { name: 'Canvas Backpack', slug: 'canvas-backpack', description: 'Durable canvas backpack with laptop compartment.', pricePaise: 299900, stock: 40, category: 'accessories', images: ['https://images.unsplash.com/photo-1553062407-98eeb64c6a62?w=800'] },
  ];

  for (const p of products) {
    await prisma.product.upsert({
      where: { slug: p.slug },
      update: {},
      create: {
        name: p.name,
        slug: p.slug,
        description: p.description,
        pricePaise: p.pricePaise,
        stock: p.stock,
        images: p.images,
        categoryId: catMap[p.category],
        active: true,
      },
    });
  }

  console.log('Seeded categories and products');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
