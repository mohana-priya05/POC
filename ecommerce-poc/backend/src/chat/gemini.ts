/**
 * Gemini-powered shopping assistant. The model can only *read* the catalogue through two tools;
 * it has no tool that creates carts, checkouts, orders or payments, and every product, price and
 * stock figure shown to the shopper comes from the database via the tool results, not from the
 * model's text. The API key is read from the environment and only ever sent to Google.
 */
import { ChatProduct, listCategories, searchCatalog } from './productSearch';

export interface HistoryTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface AssistantReply {
  reply: string;
  products: ChatProduct[];
}

export class GeminiError extends Error {
  constructor(
    public code: 'not_configured' | 'upstream',
    message: string
  ) {
    super(message);
  }
}

const SYSTEM_PROMPT = `You are the shopping assistant of "ShopPOC", an online clothing and accessories store.
Rules:
- Use the search_products and list_categories tools for ANY question about products, categories, prices or availability. Never invent products, prices or stock.
- Product cards (image, price, availability, quantity picker and a Buy button) are shown to the shopper automatically from your tool results. Do not repeat long product lists in text; give a short helpful summary instead.
- To buy something, tell the shopper to choose the quantity on the product card and press "Buy now". You cannot place orders, take payments or confirm payment or order status yourself; the checkout and payment steps are handled by the website.
- Never ask for or accept card numbers, OTPs or passwords.
- Prices are in Indian Rupees (INR). Only discuss this store's products. Keep replies short (1-3 sentences).
- If nothing matches, say so and suggest a broader search or a category.`;

const TOOLS = [
  {
    functionDeclarations: [
      {
        name: 'search_products',
        description: 'Search the store catalogue. Returns real products with their current price (INR) and stock.',
        parameters: {
          type: 'OBJECT',
          properties: {
            query: { type: 'STRING', description: 'Product keywords, e.g. "canvas backpack" or "t-shirt". Omit to browse.' },
            category: { type: 'STRING', description: 'Category name, e.g. "Accessories", "Men", "Women", "Kids".' },
            max_price_inr: { type: 'NUMBER', description: 'Maximum price in rupees.' },
            min_price_inr: { type: 'NUMBER', description: 'Minimum price in rupees.' },
            in_stock_only: { type: 'BOOLEAN', description: 'Only products that are in stock.' },
          },
        },
      },
      {
        name: 'list_categories',
        description: 'List the store categories and how many products each has.',
        parameters: { type: 'OBJECT', properties: {} },
      },
    ],
  },
];

const MAX_TOOL_ROUNDS = 3;

const RETRYABLE = new Set([429, 500, 503]);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const callGemini = async (contents: any[], attempt = 0): Promise<any> => {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new GeminiError('not_configured', 'GEMINI_API_KEY is not set.');
  const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
  let res: Response;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        tools: TOOLS,
        generationConfig: { temperature: 0.3, maxOutputTokens: 1024 },
      }),
      signal: AbortSignal.timeout(25_000),
    });
  } catch {
    throw new GeminiError('upstream', 'Could not reach Gemini.');
  }
  if (!res.ok && RETRYABLE.has(res.status) && attempt < 2) {
    await sleep(800 * (attempt + 1)); // Gemini sheds load with short 503 spikes
    return callGemini(contents, attempt + 1);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new GeminiError('upstream', `Gemini returned ${res.status}: ${detail.slice(0, 200).replace(key, '***')}`);
  }
  return (await res.json()) as any;
};

const runTool = async (name: string, args: any, collected: Map<string, ChatProduct>) => {
  if (name === 'search_products') {
    const products = await searchCatalog({
      query: typeof args?.query === 'string' ? args.query.slice(0, 100) : undefined,
      category: typeof args?.category === 'string' ? args.category.slice(0, 50) : undefined,
      maxPriceInr: typeof args?.max_price_inr === 'number' ? args.max_price_inr : undefined,
      minPriceInr: typeof args?.min_price_inr === 'number' ? args.min_price_inr : undefined,
      inStockOnly: args?.in_stock_only === true,
    });
    products.forEach(p => collected.set(p.id, p));
    return {
      count: products.length,
      products: products.map(p => ({ name: p.name, category: p.category, priceInr: p.priceInr, inStock: p.inStock, stock: p.stock })),
    };
  }
  if (name === 'list_categories') return { categories: await listCategories() };
  return { error: `unknown tool ${name}` };
};

export const askAssistant = async (history: HistoryTurn[], message: string): Promise<AssistantReply> => {
  const contents: any[] = [
    ...history.map(t => ({ role: t.role === 'assistant' ? 'model' : 'user', parts: [{ text: t.text }] })),
    { role: 'user', parts: [{ text: message }] },
  ];
  while (contents[0]?.role === 'model') contents.shift();

  const collected = new Map<string, ChatProduct>();
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const data = await callGemini(contents);
    const content = data.candidates?.[0]?.content;
    const parts: any[] = content?.parts ?? [];
    const calls = parts.filter(p => p.functionCall);

    if (!calls.length || round === MAX_TOOL_ROUNDS) {
      const text = parts
        .map(p => p.text)
        .filter(Boolean)
        .join('')
        .trim();
      return {
        reply: text || (collected.size ? 'Here is what I found.' : "Sorry, I couldn't come up with an answer. Could you rephrase?"),
        products: [...collected.values()].slice(0, 6),
      };
    }

    contents.push(content); // keep the model turn verbatim (includes any thought signatures)
    const responses = [];
    for (const c of calls) {
      responses.push({ functionResponse: { name: c.functionCall.name, response: await runTool(c.functionCall.name, c.functionCall.args, collected) } });
    }
    contents.push({ role: 'user', parts: responses });
  }
  throw new GeminiError('upstream', 'Unexpected end of tool loop.');
};
