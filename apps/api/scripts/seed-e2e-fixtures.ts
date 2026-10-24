/**
 * Business fixtures for the browser (Playwright) tests. LOCAL SCRATCH DATABASE ONLY.
 *
 * The production seed installs taxonomies, pricing and the admin, and deliberately no businesses. The browser tests need a few PUBLISHED
 * businesses (for /discover, the lead profile page, unlock and the admin Business Records table), so this script adds them to the
 * disposable `orion_e2e` database. It refuses any other target (including `orion_db`), only inserts, skips what already exists, and
 * tags every row with `metadata.e2eFixture = true` so the rows are easy to recognise and remove.
 *
 *   createdb orion_e2e && DATABASE_URL=<.../orion_e2e> ORION_ALLOWED_LOCAL_DATABASES=orion_e2e npm run drizzle:migrate
 *   ADMIN_SEED_EMAIL=admin@orion.ai (same env) npm run drizzle:seed
 *   (same env) npm run e2e:seed-fixtures
 */
import * as dotenv from 'dotenv';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import * as schema from '../src/database/schema';
import { parseDbTarget } from '../src/database/db-guard';
import { verifiedConnection } from '../src/database/tls';

dotenv.config();

export const E2E_DATABASE = 'orion_e2e';
const TAG = { e2eFixture: true };

interface IFixture {
  slug: string;
  name: string;
  description: string;
  city: string;
  district: string;
  state: string;
  pincode: string;
  address: string;
  contact: { name: string; title: string; email: string; phone: string };
  website: string;
  score: number;
}

export const FIXTURES: IFixture[] = [
  {
    slug: 'secure-enterprise-systems',
    name: 'Secure Enterprise Systems',
    description: 'Managed cybersecurity and enterprise IT infrastructure for mid-size companies.',
    city: 'Pune', district: 'Pune', state: 'Maharashtra', pincode: '411019', address: '12 MIDC Road, Bhosari',
    contact: { name: 'Anita Rao', title: 'Head of Sales', email: 'sales@secure-enterprise-systems.example', phone: '+91 98123 45670' },
    website: 'https://secure-enterprise-systems.example', score: 92,
  },
  {
    slug: 'coimbatore-precision-tools',
    name: 'Coimbatore Precision Tools',
    description: 'CNC machined components and tooling for the automotive and textile machinery sectors.',
    city: 'Coimbatore', district: 'Coimbatore', state: 'Tamil Nadu', pincode: '641018', address: '22 Avinashi Road',
    contact: { name: 'Karthik Raja', title: 'Managing Director', email: 'info@cbe-precision.example', phone: '+91 98123 45671' },
    website: 'https://cbe-precision.example', score: 81,
  },
  {
    slug: 'mysuru-lake-cafe',
    name: 'Mysuru Lake Cafe',
    description: 'Neighbourhood cafe and catering service near Kukkarahalli Lake.',
    city: 'Mysuru', district: 'Mysuru', state: 'Karnataka', pincode: '570001', address: '4 Lake Road',
    contact: { name: 'Meera Nair', title: 'Owner', email: 'hello@mysuru-lake-cafe.example', phone: '+91 98123 45672' },
    website: 'https://mysuru-lake-cafe.example', score: 64,
  },
  {
    slug: 'nagpur-sunrise-traders',
    name: 'Nagpur Sunrise Traders',
    description: 'Wholesale distribution of household goods across Vidarbha.',
    city: 'Nagpur', district: 'Nagpur', state: 'Maharashtra', pincode: '440001', address: '7 Market Street',
    contact: { name: 'Rahul Deshmukh', title: 'Proprietor', email: 'contact@sunrise-traders.example', phone: '+91 98123 45673' },
    website: 'https://sunrise-traders.example', score: 55,
  },
  {
    slug: 'chennai-bright-logistics',
    name: 'Chennai Bright Logistics',
    description: 'Road freight and warehousing for e-commerce sellers in Tamil Nadu.',
    city: 'Chennai', district: 'Chennai', state: 'Tamil Nadu', pincode: '600002', address: '5 Anna Salai',
    contact: { name: 'Divya Subramanian', title: 'Operations Manager', email: 'ops@bright-logistics.example', phone: '+91 98123 45674' },
    website: 'https://bright-logistics.example', score: 73,
  },
];

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  const target = parseDbTarget(url);
  if (!target.local || target.database !== E2E_DATABASE) {
    throw new Error(`Refusing to seed fixtures: the target must be the local "${E2E_DATABASE}" scratch database (got host ${target.host}, database "${target.database}").`);
  }
  const pool = new Pool({ ...verifiedConnection(url as string), max: 1 });
  const db = drizzle(pool, { schema });
  try {
    const industry = await db.query.industries.findFirst({ where: eq(schema.industries.isActive, true) });
    const category = industry ? await db.query.categories.findFirst({ where: eq(schema.categories.industryId, industry.id) }) : undefined;
    let created = 0;
    for (const f of FIXTURES) {
      const existing = await db.query.businesses.findFirst({ where: eq(schema.businesses.slug, f.slug) });
      if (existing) continue;
      await db.transaction(async (tx) => {
        const [biz] = await tx
          .insert(schema.businesses)
          .values({
            slug: f.slug, name: f.name, legalName: `${f.name} Private Limited`, status: 'PUBLISHED', publishedAt: new Date(),
            industryId: industry?.id ?? null, categoryId: category?.id ?? null, description: f.description, foundingYear: 2012,
            isVerified: true, isEnriched: true, lastEnrichedAt: new Date(), metadata: TAG,
          })
          .returning();
        await tx.insert(schema.businessLocations).values({
          businessId: biz.id, addressLine1: f.address, city: f.city, district: f.district, state: f.state, pincode: f.pincode,
          isPrimary: true, isRegisteredOffice: true, metadata: TAG,
        });
        await tx.insert(schema.businessContacts).values({
          businessId: biz.id, fullName: f.contact.name, title: f.contact.title, email: f.contact.email, phone: f.contact.phone,
          isEmailVerified: true, isPhoneVerified: true, isPrimary: true, isDecisionMaker: true, metadata: TAG,
        });
        await tx.insert(schema.digitalPresences).values({
          businessId: biz.id, platform: 'WEBSITE', url: f.website, domain: new URL(f.website).hostname, isVerified: true, isActive: true, metadata: TAG,
        });
        await tx.insert(schema.businessScores).values({ businessId: biz.id, orionScore: f.score });
      });
      created++;
    }
    console.log(`✓ E2E fixtures: ${created} created, ${FIXTURES.length - created} already present (database ${E2E_DATABASE}).`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`✗ ${(err as Error).message}`);
    process.exit(1);
  });
}
